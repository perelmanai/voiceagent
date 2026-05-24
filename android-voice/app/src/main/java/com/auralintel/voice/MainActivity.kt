package com.auralintel.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.text.format.DateFormat
import android.util.Log
import android.widget.Button
import android.widget.EditText
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Date
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Captures speech on-device with [SpeechRecognizer] and pushes each finalized line to
 * the dashboard's POST /api/ingest endpoint, keyed by a pairing code. Mirrors the
 * dashboard's browser behavior: continuous listening via a restart loop.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: SharedPreferences
    private lateinit var urlField: EditText
    private lateinit var codeField: EditText
    private lateinit var scanButton: Button
    private lateinit var micButton: Button
    private lateinit var statusText: TextView
    private lateinit var interimText: TextView
    private lateinit var logText: TextView
    private lateinit var logScroll: ScrollView

    private var recognizer: SpeechRecognizer? = null
    private var listening = false

    private val net: ExecutorService = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    companion object {
        private const val PREFS = "aural_voice"
        private const val KEY_URL = "base_url"
        private const val KEY_CODE = "pair_code"
        private const val MIC_PERMISSION = 1001
        private const val TAG = "AuralVoice"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        urlField = findViewById(R.id.urlField)
        codeField = findViewById(R.id.codeField)
        scanButton = findViewById(R.id.scanButton)
        micButton = findViewById(R.id.micButton)
        statusText = findViewById(R.id.statusText)
        interimText = findViewById(R.id.interimText)
        logText = findViewById(R.id.logText)
        logScroll = findViewById(R.id.logScroll)

        urlField.setText(prefs.getString(KEY_URL, ""))
        codeField.setText(prefs.getString(KEY_CODE, ""))

        micButton.setOnClickListener {
            if (listening) stopListening() else startListening()
        }
        scanButton.setOnClickListener { scanQr() }
    }

    // --- QR pairing ------------------------------------------------------------

    /**
     * Launches the Play Services full-screen QR scanner (no camera permission needed)
     * and fills the URL + code from a payload of the form {"url":"...","code":"..."}.
     */
    private fun scanQr() {
        val options = GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build()
        GmsBarcodeScanning.getClient(this, options)
            .startScan()
            .addOnSuccessListener { barcode ->
                val raw = barcode.rawValue
                if (raw.isNullOrBlank()) {
                    toast("Empty QR code.")
                    return@addOnSuccessListener
                }
                try {
                    val json = JSONObject(raw)
                    val url = json.optString("url").trim()
                    val pairCode = json.optString("code").trim()
                    if (url.isEmpty() || pairCode.isEmpty()) {
                        toast("QR code is missing the URL or code.")
                        return@addOnSuccessListener
                    }
                    urlField.setText(url)
                    codeField.setText(pairCode)
                    savePrefs()
                    status("Paired with $url — tap Start mic.")
                } catch (e: Exception) {
                    Log.e(TAG, "bad QR payload: $raw", e)
                    toast("That QR code isn't an Aural pairing code.")
                }
            }
            .addOnCanceledListener { status("Scan cancelled.") }
            .addOnFailureListener { e ->
                Log.e(TAG, "scan failed", e)
                toast("Scanner unavailable: ${e.message}")
            }
    }

    // --- Listening lifecycle ---------------------------------------------------

    private fun startListening() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            status("Speech recognition is not available on this device.")
            return
        }
        if (baseUrl().isEmpty() || code().isEmpty()) {
            toast("Enter the dashboard URL and pairing code first.")
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                this, arrayOf(Manifest.permission.RECORD_AUDIO), MIC_PERMISSION
            )
            return
        }

        savePrefs()
        setInputsEnabled(false)
        listening = true
        ensureRecognizer()
        beginRecognition()
        updateButton()
        status("Listening…")
    }

    private fun stopListening() {
        listening = false
        try {
            recognizer?.cancel()
        } catch (e: Exception) {
            Log.e(TAG, "cancel failed", e)
        }
        interimText.text = ""
        setInputsEnabled(true)
        updateButton()
        status("Stopped")
    }

    private fun ensureRecognizer() {
        if (recognizer == null) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this).apply {
                setRecognitionListener(listener)
            }
        }
    }

    private fun beginRecognition() {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM
            )
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.US.toString())
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
        }
        try {
            recognizer?.startListening(intent)
        } catch (e: Exception) {
            Log.e(TAG, "startListening failed", e)
            restartSoon()
        }
    }

    /** Restart the recognizer to keep listening across utterances. */
    private fun restartSoon() {
        if (!listening) return
        main.postDelayed({
            if (!listening) return@postDelayed
            try {
                recognizer?.cancel()
                beginRecognition()
            } catch (e: Exception) {
                Log.e(TAG, "restart failed", e)
            }
        }, 350)
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}

        override fun onPartialResults(partialResults: Bundle?) {
            firstResult(partialResults)?.let { interimText.text = it }
        }

        override fun onResults(results: Bundle?) {
            interimText.text = ""
            val text = firstResult(results)
            if (!text.isNullOrBlank()) {
                appendLine(text)
                send(text)
            }
            restartSoon()
        }

        override fun onError(error: Int) {
            when (error) {
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> {
                    listening = false
                    setInputsEnabled(true)
                    updateButton()
                    status("Microphone permission is required.")
                }
                // No-match / timeout / busy are normal during continuous use — restart.
                else -> restartSoon()
            }
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun firstResult(b: Bundle?): String? =
        b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim()

    // --- Networking ------------------------------------------------------------

    /** POST {code, text} to <baseUrl>/api/ingest off the main thread, retry once. */
    private fun send(text: String) {
        val base = baseUrl()
        val pairCode = code()
        net.execute {
            if (!postOnce(base, pairCode, text)) {
                if (!postOnce(base, pairCode, text)) {
                    main.post { status("Send failed — check the URL and that the dashboard is reachable.") }
                }
            }
        }
    }

    private fun postOnce(base: String, pairCode: String, text: String): Boolean {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL("$base/api/ingest").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 6000
                readTimeout = 6000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
            val payload = JSONObject().put("code", pairCode).put("text", text).toString()
            conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
            val rc = conn.responseCode
            if (rc in 200..299) {
                main.post { if (listening) status("Sent ✓  ·  listening…") }
                true
            } else {
                Log.w(TAG, "ingest returned $rc")
                false
            }
        } catch (e: Exception) {
            Log.e(TAG, "post failed", e)
            false
        } finally {
            conn?.disconnect()
        }
    }

    // --- Helpers ---------------------------------------------------------------

    private fun baseUrl(): String {
        var u = urlField.text.toString().trim().trimEnd('/')
        if (u.isEmpty()) return u
        if (!u.startsWith("http://") && !u.startsWith("https://")) {
            // Local/LAN dashboards run plain HTTP; defaulting to https breaks pairing.
            val host = u.substringBefore(':').substringBefore('/')
            val isLocal = host == "localhost" ||
                host == "127.0.0.1" ||
                host.startsWith("10.") ||
                host.startsWith("192.168.") ||
                host.matches(Regex("^172\\.(1[6-9]|2\\d|3[01])\\..*"))
            u = if (isLocal) "http://$u" else "https://$u"
        }
        return u
    }

    private fun code(): String = codeField.text.toString().trim().uppercase(Locale.US)

    private fun savePrefs() {
        prefs.edit()
            .putString(KEY_URL, baseUrl())
            .putString(KEY_CODE, code())
            .apply()
    }

    private fun appendLine(text: String) {
        val ts = DateFormat.format("HH:mm:ss", Date()).toString()
        val existing = logText.text
        logText.text = if (existing.isNullOrEmpty()) "[$ts] $text" else "$existing\n[$ts] $text"
        logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }

    private fun updateButton() {
        micButton.text = if (listening) "Stop" else "Start mic"
    }

    private fun setInputsEnabled(enabled: Boolean) {
        urlField.isEnabled = enabled
        codeField.isEnabled = enabled
        scanButton.isEnabled = enabled
    }

    private fun status(msg: String) {
        statusText.text = msg
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == MIC_PERMISSION) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startListening()
            } else {
                status("Microphone permission denied.")
            }
        }
    }

    override fun onDestroy() {
        listening = false
        try {
            recognizer?.destroy()
        } catch (e: Exception) {
            Log.e(TAG, "destroy failed", e)
        }
        net.shutdownNow()
        super.onDestroy()
    }
}
