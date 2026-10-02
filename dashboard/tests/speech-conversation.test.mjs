import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpeechConversation, sentenceQuietWindow, SENTENCE_QUIET_MS, UNPUNCTUATED_QUIET_MS } from '../src/lib/speech-conversation.ts';
import { parseSpeechPayload } from '../src/lib/speech-protocol.ts';

function send(buffer, type, text, at, utteranceId = 'one', sequence, speaker = 'You') {
  return buffer.accept({ speaker, type, text, utteranceId, sequence }, at);
}

test('recognition finals join across a long pause in an unfinished sentence', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'I want to book a flight to.', 0);
  assert.equal(buffer.nextDeadline(), null);
  assert.deepEqual(buffer.settle(60_000), []);
  send(buffer, 'final', 'Seattle tomorrow.', 60_001, 'two');
  assert.equal(buffer.snapshot().length, 1);
  assert.equal(buffer.snapshot()[0].text, 'I want to book a flight to Seattle tomorrow.');
  assert.equal(buffer.settle(60_001 + SENTENCE_QUIET_MS - 1).length, 0);
  assert.equal(buffer.settle(60_001 + SENTENCE_QUIET_MS)[0].text, 'I want to book a flight to Seattle tomorrow.');
});

test('live partial revisions replace the same chunk and the final replaces its preview', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'partial', 'Find a flite', 0, 'one', 1);
  send(buffer, 'partial', 'Find a flight to Boston', 200, 'one', 2);
  assert.equal(buffer.nextDeadline(), null);
  assert.equal(buffer.snapshot()[0].text, 'Find a flight to Boston');
  send(buffer, 'final', 'Find a flight to Austin.', 500, 'one', 3);
  assert.equal(buffer.snapshot()[0].text, 'Find a flight to Austin.');
  assert.equal(buffer.settle(500 + SENTENCE_QUIET_MS).length, 1);
});

test('retried and out-of-order events do not duplicate text or reopen a completed sentence', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'Find pizza.', 0, 'one', 3);
  assert.equal(send(buffer, 'final', 'Find pizza.', 100, 'one', 3).changed, false);
  assert.equal(send(buffer, 'partial', 'Find', 200, 'one', 2).changed, false);
  assert.equal(send(buffer, 'partial', 'Find pizza', 300, 'one', 4).changed, false);
  buffer.settle(SENTENCE_QUIET_MS);
  assert.equal(send(buffer, 'final', 'Find pizza.', 3000, 'one', 5).changed, false);
  assert.equal(buffer.snapshot().length, 1);
  assert.equal(buffer.snapshot()[0].isFinal, true);
});

test('same words in distinct chunks remain intact', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'That was very', 0, 'one');
  send(buffer, 'final', 'very good.', 100, 'two');
  assert.equal(buffer.snapshot()[0].text, 'That was very very good.');
});

test('speech activity and partials cancel the old endpoint until the resumed speech finishes', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'Find pizza.', 0);
  send(buffer, 'activity', '', 1700, 'two');
  assert.deepEqual(buffer.settle(10_000), []);
  assert.equal(buffer.nextDeadline(), null);
  send(buffer, 'partial', 'near', 10_001, 'two');
  assert.deepEqual(buffer.settle(30_000), []);
  send(buffer, 'final', 'near my hotel.', 30_001, 'two');
  assert.equal(buffer.snapshot().length, 1);
  assert.equal(buffer.settle(30_001 + SENTENCE_QUIET_MS)[0].text, 'Find pizza. near my hotel.');
});

test('unpunctuated complete speech has a longer grace period', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'Find coffee near Union Square', 0);
  assert.equal(buffer.nextDeadline(), UNPUNCTUATED_QUIET_MS);
  assert.deepEqual(buffer.settle(SENTENCE_QUIET_MS), []);
  assert.equal(buffer.settle(UNPUNCTUATED_QUIET_MS).length, 1);
});

test('a delayed browser final cannot clear speech activity from a newer phrase', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'activity', '', 0, 'audio');
  send(buffer, 'partial', 'Find pizza', 100, 'one');
  send(buffer, 'pause', '', 300, 'audio');
  send(buffer, 'activity', '', 500, 'audio');
  send(buffer, 'final', 'Find pizza.', 700, 'one');
  assert.equal(buffer.isSpeaking(), true);
  assert.equal(buffer.nextDeadline(), null);
  assert.deepEqual(buffer.settle(10_000), []);
  send(buffer, 'partial', 'near the hotel', 10_001, 'two');
  send(buffer, 'pause', '', 10_100, 'audio');
  send(buffer, 'final', 'near the hotel.', 10_200, 'two');
  assert.equal(buffer.settle(10_200 + SENTENCE_QUIET_MS).length, 1);
});

test('clear dangling clauses remain pending even after ASR inserts punctuation', () => {
  for (const text of ['I want to book a flight to', 'I want to book a flight to.', 'I think because', 'We will go and then.', 'Can you', 'I need a', 'After lunch,']) {
    assert.equal(sentenceQuietWindow(text), null, text);
  }
});

test('complete pronouns, relative clauses and questions can settle', () => {
  for (const text of ['I love her.', 'That is his.', 'That is what I am looking for.', 'What is it for?', 'Yes, I can.', 'Tell me where she is.']) {
    assert.equal(sentenceQuietWindow(text), SENTENCE_QUIET_MS, text);
  }
});

test('speaker changes keep separate turns and each source stops independently', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'I want to', 0, 'one', 1, 'You');
  send(buffer, 'partial', 'Find a hotel', 100, 'one', 1, 'Phone');
  const result = send(buffer, 'stop', '', 200, 'one', 2, 'Phone');
  assert.equal(result.completed.length, 1);
  assert.equal(result.completed[0].speaker, 'Phone');
  assert.deepEqual(buffer.snapshot().map((line) => [line.speaker, line.isFinal]), [['You', false], ['Phone', true]]);
});

test('explicit Stop preserves and flushes the latest unfinished partial once', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'partial', 'I would like to', 0, 'one', 1);
  const result = send(buffer, 'stop', '', 200, 'one', 2);
  assert.deepEqual(result.completed.map((turn) => turn.text), ['I would like to']);
  assert.equal(buffer.snapshot()[0].isFinal, true);
  assert.equal(send(buffer, 'stop', '', 300, 'one', 2).changed, false);
  assert.equal(buffer.nextDeadline(), null);
});

test('unexpected recognizer end preserves partials without flushing an unfinished thought', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'partial', 'Book a flight to', 0);
  send(buffer, 'end', '', 100, 'cycle-end');
  assert.deepEqual(buffer.settle(20_000), []);
  send(buffer, 'final', 'Boston.', 20_001, 'restart-one');
  assert.equal(buffer.snapshot()[0].text, 'Book a flight to Boston.');
  assert.equal(buffer.settle(20_001 + SENTENCE_QUIET_MS).length, 1);
});

test('an empty recognition cycle releases activity and keeps the quiet period from the last activity', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'Find pizza.', 0);
  send(buffer, 'activity', '', 1000, 'two', 1);
  assert.equal(buffer.nextDeadline(), null);
  send(buffer, 'end', '', 1500, 'two', 2);
  assert.equal(buffer.nextDeadline(), 1000 + SENTENCE_QUIET_MS);
  assert.equal(buffer.settle(1000 + SENTENCE_QUIET_MS).length, 1);
});

test('stop and onend after a settled turn are no-ops so an in-flight analysis is not invalidated', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'Find pizza.', 0);
  buffer.settle(SENTENCE_QUIET_MS);
  assert.deepEqual(send(buffer, 'end', '', 2000, 'end'), { changed: false, completed: [] });
  assert.deepEqual(send(buffer, 'stop', '', 2100, 'stop'), { changed: false, completed: [] });
});

test('a corrected final updates its original turn rather than appending a duplicate', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'Find Austin hotels.', 0, 'one', 1);
  buffer.settle(SENTENCE_QUIET_MS);
  send(buffer, 'final', 'Find Boston hotels.', 2500, 'one', 2);
  assert.equal(buffer.snapshot().length, 1);
  assert.equal(buffer.snapshot()[0].text, 'Find Boston hotels.');
  assert.equal(buffer.snapshot()[0].isFinal, false);
});

test('phone payloads remain compatible with old clients and preserve new revision metadata', () => {
  assert.deepEqual(parseSpeechPayload({ code: ' abcd ', text: ' hello ' }, 10), { code: 'ABCD', line: { text: 'hello', ts: 10 } });
  for (const type of ['activity', 'partial', 'final', 'stop', 'end']) {
    const text = ['partial', 'final'].includes(type) ? 'hello' : '';
    assert.deepEqual(parseSpeechPayload({ code: 'ABCD', text, type, utteranceId: 'session:cycle-1', sequence: 2 }, 20)?.line, {
      text, type, utteranceId: 'session:cycle-1', sequence: 2, ts: 20,
    });
  }
});

test('invalid phone events cannot crash ingest or escape the relay directory', () => {
  for (const input of [null, [], 'hello', { code: 1, text: 'a' }, { code: '../abcd', text: 'a' }, { code: 'ABCD', text: {} }, { code: 'ABCD', text: '' }, { code: 'ABCD', text: 'hello', type: 'partial' }, { code: 'ABCD', text: 'hello', type: 'partial', utteranceId: 'one', sequence: -1 }, { code: 'ABCD', text: 'hello', type: 'oops', utteranceId: 'one', sequence: 1 }]) {
    assert.equal(parseSpeechPayload(input), null);
  }
});
