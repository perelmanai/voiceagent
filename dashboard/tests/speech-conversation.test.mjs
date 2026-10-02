import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpeechConversation, sentenceQuietWindow, SENTENCE_QUIET_MS, UNPUNCTUATED_QUIET_MS, MAX_SPEECH_QUIET_MS } from '../src/lib/speech-conversation.ts';
import { parseSpeechPayload } from '../src/lib/speech-protocol.ts';

function send(buffer, type, text, at, utteranceId = 'one', sequence, speaker = 'You') {
  return buffer.accept({ speaker, type, text, utteranceId, sequence }, at);
}

test('recognition finals join across a four-second pause in an unfinished sentence', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'I want to book a flight to.', 0);
  assert.equal(buffer.nextDeadline(), MAX_SPEECH_QUIET_MS);
  assert.deepEqual(buffer.settle(4000), []);
  send(buffer, 'final', 'Seattle tomorrow.', 4001, 'two');
  assert.equal(buffer.snapshot().length, 1);
  assert.equal(buffer.snapshot()[0].text, 'I want to book a flight to Seattle tomorrow.');
  assert.equal(buffer.settle(4001 + SENTENCE_QUIET_MS - 1).length, 0);
  assert.equal(buffer.settle(4001 + SENTENCE_QUIET_MS)[0].text, 'I want to book a flight to Seattle tomorrow.');
});

test('live partial revisions replace the same chunk and the final replaces its preview', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'partial', 'Find a flite', 0, 'one', 1);
  send(buffer, 'partial', 'Find a flight to Boston', 200, 'one', 2);
  assert.equal(buffer.nextDeadline(), 200 + MAX_SPEECH_QUIET_MS);
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
  assert.deepEqual(buffer.settle(5700), []);
  assert.equal(buffer.nextDeadline(), 1700 + MAX_SPEECH_QUIET_MS);
  send(buffer, 'partial', 'near', 5800, 'two');
  assert.deepEqual(buffer.settle(9800), []);
  send(buffer, 'final', 'near my hotel.', 10_000, 'two');
  assert.equal(buffer.snapshot().length, 1);
  assert.equal(buffer.settle(10_000 + SENTENCE_QUIET_MS)[0].text, 'Find pizza. near my hotel.');
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
  assert.equal(buffer.nextDeadline(), 700 + MAX_SPEECH_QUIET_MS);
  assert.deepEqual(buffer.settle(4700), []);
  send(buffer, 'partial', 'near the hotel', 4800, 'two');
  send(buffer, 'pause', '', 4900, 'audio');
  send(buffer, 'final', 'near the hotel.', 5000, 'two');
  assert.equal(buffer.settle(5000 + SENTENCE_QUIET_MS).length, 1);
});

test('clear dangling clauses use the conservative classifier even after ASR inserts punctuation', () => {
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
  assert.deepEqual(buffer.settle(4000), []);
  send(buffer, 'final', 'Boston.', 4001, 'restart-one');
  assert.equal(buffer.snapshot()[0].text, 'Book a flight to Boston.');
  assert.equal(buffer.settle(4001 + SENTENCE_QUIET_MS).length, 1);
});

test('an empty recognition cycle releases activity and keeps the quiet period from the last activity', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'Find pizza.', 0);
  send(buffer, 'activity', '', 1000, 'two', 1);
  assert.equal(buffer.nextDeadline(), 1000 + MAX_SPEECH_QUIET_MS);
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

test('a corrected final replaces text only while its turn is still open', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'Find Austin hotels.', 0, 'one', 1);
  send(buffer, 'final', 'Find Boston hotels.', 1000, 'one', 2);
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


test('a dangling clause stops waiting at the maximum quiet deadline', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'I would like to', 0);
  assert.equal(buffer.nextDeadline(), MAX_SPEECH_QUIET_MS);
  assert.deepEqual(buffer.settle(MAX_SPEECH_QUIET_MS - 1), []);
  assert.deepEqual(buffer.settle(MAX_SPEECH_QUIET_MS).map((turn) => turn.text), ['I would like to']);
  assert.equal(buffer.snapshot()[0].isFinal, true);
  assert.equal(buffer.nextDeadline(), null);
  assert.deepEqual(buffer.settle(MAX_SPEECH_QUIET_MS + 10_000), []);
});

test('missing final and speechend callbacks cannot strand the last visible partial', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'activity', '', 0, 'audio');
  send(buffer, 'partial', 'Find a restaurant near', 100, 'one', 1);
  assert.equal(buffer.isSpeaking(), true);
  assert.deepEqual(buffer.settle(100 + MAX_SPEECH_QUIET_MS - 1), []);
  assert.deepEqual(buffer.settle(100 + MAX_SPEECH_QUIET_MS).map((turn) => turn.text), ['Find a restaurant near']);
  assert.equal(buffer.snapshot()[0].isFinal, true);
  assert.equal(buffer.isSpeaking(), false);
  assert.equal(buffer.nextDeadline(), null);
});

test('new words and renewed speech move the maximum quiet deadline forward', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'partial', 'I want to', 0, 'one', 1);
  send(buffer, 'partial', 'I want to find a', 4000, 'one', 2);
  assert.equal(buffer.nextDeadline(), 4000 + MAX_SPEECH_QUIET_MS);
  assert.deepEqual(buffer.settle(MAX_SPEECH_QUIET_MS), []);
  send(buffer, 'activity', '', 8500, 'audio', 1);
  assert.equal(buffer.nextDeadline(), 8500 + MAX_SPEECH_QUIET_MS);
  assert.deepEqual(buffer.settle(8500 + MAX_SPEECH_QUIET_MS - 1), []);
  assert.equal(buffer.settle(8500 + MAX_SPEECH_QUIET_MS).length, 1);
});

test('repeated unchanged partials and network retries cannot extend waiting forever', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'partial', 'Find a restaurant near', 0, 'one', 1);
  assert.equal(send(buffer, 'partial', 'Find a restaurant near', 4000, 'one', 2).changed, false);
  assert.equal(send(buffer, 'partial', 'Find a restaurant near', 4500, 'one', 2).changed, false);
  assert.equal(buffer.nextDeadline(), MAX_SPEECH_QUIET_MS);
  assert.equal(buffer.settle(MAX_SPEECH_QUIET_MS).length, 1);
});

test('a late rewrite cannot reopen or change a timed-out turn', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'partial', 'Find Austin hotels', 0, 'one', 1);
  buffer.settle(MAX_SPEECH_QUIET_MS);
  assert.equal(buffer.snapshot()[0].isFinal, true);
  assert.equal(send(buffer, 'final', 'Find Boston hotels.', MAX_SPEECH_QUIET_MS + 100, 'one', 2).changed, false);
  assert.equal(buffer.snapshot().length, 1);
  assert.equal(buffer.snapshot()[0].text, 'Find Austin hotels');
  assert.equal(buffer.snapshot()[0].isFinal, true);
  assert.equal(buffer.settle(MAX_SPEECH_QUIET_MS + 100 + SENTENCE_QUIET_MS).length, 0);
});

test('each speaker times out independently without clearing newer speech from another source', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'activity', '', 0, 'audio', 1, 'You');
  send(buffer, 'partial', 'I would like to', 0, 'one', 1, 'You');
  send(buffer, 'activity', '', 1000, 'audio', 1, 'Phone');
  send(buffer, 'partial', 'Find a hotel near', 1100, 'one', 1, 'Phone');
  assert.deepEqual(buffer.settle(MAX_SPEECH_QUIET_MS).map((turn) => turn.speaker), ['You']);
  assert.deepEqual(buffer.snapshot().map((line) => [line.speaker, line.isFinal]), [['You', true], ['Phone', false]]);
  assert.equal(buffer.isSpeaking(), true);
  assert.equal(buffer.nextDeadline(), 1100 + MAX_SPEECH_QUIET_MS);
  assert.deepEqual(buffer.settle(1100 + MAX_SPEECH_QUIET_MS).map((turn) => turn.speaker), ['Phone']);
  assert.equal(buffer.isSpeaking(), false);
});

test('a late recognition end does not restart the five-second silence timeout', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'partial', 'Book a flight to', 0, 'one');
  send(buffer, 'end', '', MAX_SPEECH_QUIET_MS - 100, 'end');
  assert.equal(buffer.nextDeadline(), MAX_SPEECH_QUIET_MS);
  assert.equal(buffer.settle(MAX_SPEECH_QUIET_MS).length, 1);
});

test('a noise-only activity cycle expires even when the recognizer sends no end event', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'activity', '', 100, 'audio', 1);
  assert.equal(buffer.nextDeadline(), 100 + MAX_SPEECH_QUIET_MS);
  assert.equal(buffer.isSpeaking(), true);
  assert.deepEqual(buffer.settle(100 + MAX_SPEECH_QUIET_MS), []);
  assert.equal(buffer.isSpeaking(), false);
  assert.equal(buffer.nextDeadline(), null);
  assert.deepEqual(buffer.snapshot(), []);
});

test('an unchanged late final confirms a timed-out preview without reanalyzing it', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'partial', 'Find hotels near Boston', 0, 'one', 1);
  buffer.settle(MAX_SPEECH_QUIET_MS);
  assert.equal(send(buffer, 'final', 'Find hotels near Boston', MAX_SPEECH_QUIET_MS + 100, 'one', 2).changed, false);
  assert.equal(buffer.snapshot()[0].isFinal, true);
  assert.equal(buffer.nextDeadline(), null);
  assert.deepEqual(buffer.settle(MAX_SPEECH_QUIET_MS + 10_000), []);
});

test('a cumulative partial after timeout puts only the new suffix in a separate turn', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'partial', 'Find hotels near', 0, 'one', 1);
  buffer.settle(MAX_SPEECH_QUIET_MS);
  send(buffer, 'partial', 'Find hotels near Boston', MAX_SPEECH_QUIET_MS + 100, 'one', 2);
  assert.equal(buffer.snapshot().length, 2);
  assert.deepEqual(buffer.snapshot().map((line) => [line.text, line.isFinal]), [['Find hotels near', true], ['Boston', false]]);
  send(buffer, 'final', 'Find hotels near Boston.', MAX_SPEECH_QUIET_MS + 200, 'one', 3);
  assert.equal(buffer.settle(MAX_SPEECH_QUIET_MS + 200 + SENTENCE_QUIET_MS).length, 1);
  assert.equal(buffer.snapshot().length, 2);
});

test('new text arriving after a delayed timer deadline closes the previous turn first', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'Find pizza.', 0, 'one', 1);
  const update = send(buffer, 'partial', 'Look for hotels', SENTENCE_QUIET_MS + 100, 'two', 1);
  assert.deepEqual(update.completed.map((turn) => turn.text), ['Find pizza.']);
  assert.equal(update.changed, true);
  assert.deepEqual(buffer.snapshot().map((line) => [line.text, line.isFinal]), [['Find pizza.', true], ['Look for hotels', false]]);
});

test('new activity after a quiet deadline cannot extend or reopen the finished thought', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'Find coffee near Union Square', 0, 'one');
  const update = send(buffer, 'activity', '', UNPUNCTUATED_QUIET_MS + 100, 'audio');
  assert.deepEqual(update.completed.map((turn) => turn.text), ['Find coffee near Union Square']);
  send(buffer, 'partial', 'Now find a bookstore', UNPUNCTUATED_QUIET_MS + 200, 'two');
  assert.deepEqual(buffer.snapshot().map((line) => [line.text, line.isFinal]), [['Find coffee near Union Square', true], ['Now find a bookstore', false]]);
});

test('even an ignored retry returns any turn completed by an overdue deadline', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'Find pizza.', 0, 'one', 1);
  const update = send(buffer, 'final', 'Find pizza.', SENTENCE_QUIET_MS + 1, 'one', 1);
  assert.equal(update.changed, true);
  assert.deepEqual(update.completed.map((turn) => turn.text), ['Find pizza.']);
  assert.equal(buffer.snapshot()[0].isFinal, true);
  assert.equal(buffer.nextDeadline(), null);
});

test('repeated cumulative ASR updates create distinct turns without replaying their frozen prefixes', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'partial', 'Book a flight', 0, 'one', 1);
  buffer.settle(MAX_SPEECH_QUIET_MS);
  const first = buffer.snapshot()[0];
  send(buffer, 'partial', 'Book a flight Find hotels', 5100, 'one', 2);
  send(buffer, 'partial', 'Book a flight Find hotels near Paris', 5200, 'one', 3);
  send(buffer, 'final', 'Book a flight. Find hotels near Paris.', 5300, 'one', 4);
  assert.deepEqual(buffer.snapshot().map((line) => line.text), ['Book a flight', 'Find hotels near Paris.']);
  buffer.settle(5300 + SENTENCE_QUIET_MS);
  const second = buffer.snapshot()[1];
  send(buffer, 'partial', 'Book a flight. Find hotels near Paris. Compare restaurants', 7200, 'one', 5);
  assert.deepEqual(buffer.snapshot().map((line) => line.text), ['Book a flight', 'Find hotels near Paris.', 'Compare restaurants']);
  assert.deepEqual(buffer.snapshot()[0], first);
  assert.deepEqual(buffer.snapshot()[1], second);
});

test('cumulative prefix matching tolerates ASR punctuation and casing changes', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'Book a Flight.', 0, 'one', 1);
  buffer.settle(SENTENCE_QUIET_MS);
  send(buffer, 'partial', 'book a flight, Find a hotel', 1900, 'one', 2);
  assert.deepEqual(buffer.snapshot().map((line) => [line.text, line.isFinal]), [['Book a Flight.', true], ['Find a hotel', false]]);
});

test('late rewrites or cumulative tails from an older recognition ID cannot change the current turn', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'Find pizza.', 0, 'one', 1);
  buffer.settle(SENTENCE_QUIET_MS);
  send(buffer, 'partial', 'Compare hotel prices', 2000, 'two', 1);
  const before = buffer.snapshot();
  const deadline = buffer.nextDeadline();
  assert.equal(send(buffer, 'final', 'Find pasta.', 2100, 'one', 2).changed, false);
  assert.equal(send(buffer, 'partial', 'Find pizza. Order a drink', 2200, 'one', 3).changed, false);
  assert.deepEqual(buffer.snapshot(), before);
  assert.equal(buffer.nextDeadline(), deadline);
});

test('resuming an unfinished sentence after its five-second ceiling starts a new turn', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'I want to go to', 0, 'one');
  const update = send(buffer, 'final', 'Paris tomorrow.', MAX_SPEECH_QUIET_MS + 1, 'two');
  assert.deepEqual(update.completed.map((turn) => turn.text), ['I want to go to']);
  assert.deepEqual(buffer.snapshot().map((line) => [line.text, line.isFinal]), [['I want to go to', true], ['Paris tomorrow.', false]]);
});

test('an explicit new topic starts a distinct turn even before the short silence timer expires', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'Find pizza.', 0, 'one');
  const update = send(buffer, 'final', 'Now I need a hotel.', 700, 'two');
  assert.deepEqual(update.completed.map((turn) => turn.text), ['Find pizza.']);
  assert.deepEqual(buffer.snapshot().map((line) => [line.text, line.isFinal]), [['Find pizza.', true], ['Now I need a hotel.', false]]);
});

test('a topic transition recognized over successive partials splits off only the new segment', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'Find pizza.', 0, 'one');
  send(buffer, 'partial', 'Now', 600, 'two');
  const update = send(buffer, 'partial', 'Now I need a hotel', 700, 'two');
  assert.deepEqual(update.completed.map((turn) => turn.text), ['Find pizza.']);
  assert.deepEqual(buffer.snapshot().map((line) => [line.text, line.isFinal]), [['Find pizza.', true], ['Now I need a hotel', false]]);
  send(buffer, 'final', 'Now I need a hotel near the airport.', 800, 'two');
  assert.deepEqual(buffer.snapshot().map((line) => line.text), ['Find pizza.', 'Now I need a hotel near the airport.']);
});

test('a quick modifier remains part of the same thought without an explicit topic change', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'final', 'Find pizza.', 0, 'one');
  const update = send(buffer, 'final', 'near my hotel.', 700, 'two');
  assert.deepEqual(update.completed, []);
  assert.equal(buffer.snapshot().length, 1);
  assert.equal(buffer.snapshot()[0].text, 'Find pizza. near my hotel.');
});

test('a correction to a frozen word does not discard an explicit new-topic tail', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'partial', 'I need flour.', 0, 'one', 1);
  buffer.settle(MAX_SPEECH_QUIET_MS);
  send(buffer, 'partial', 'I need flowers. Now find a florist', 6000, 'one', 2);
  assert.deepEqual(buffer.snapshot().map((line) => [line.text, line.isFinal]), [['I need flour.', true], ['Now find a florist', false]]);
  send(buffer, 'final', 'I need flowers. Now find a florist nearby.', 6100, 'one', 3);
  assert.deepEqual(buffer.snapshot().map((line) => line.text), ['I need flour.', 'Now find a florist nearby.']);
  buffer.settle(6100 + SENTENCE_QUIET_MS);
  assert.equal(send(buffer, 'final', 'I need flowers. Now find a florist nearby.', 8000, 'one', 4).changed, false);
  assert.equal(buffer.snapshot().length, 2);
});

test('corrected cumulative text cannot replay a topic marker already in the frozen prefix', () => {
  const buffer = new SpeechConversation();
  send(buffer, 'partial', 'Now I need flour.', 0, 'one', 1);
  buffer.settle(MAX_SPEECH_QUIET_MS);
  assert.equal(send(buffer, 'final', 'Now I need flowers.', 6000, 'one', 2).changed, false);
  assert.equal(buffer.snapshot().length, 1);
  send(buffer, 'partial', 'Now I need flowers. Now find a florist', 6100, 'one', 3);
  assert.deepEqual(buffer.snapshot().map((line) => line.text), ['Now I need flour.', 'Now find a florist']);
});
