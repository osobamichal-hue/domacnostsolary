package cz.homeapp.android

import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.util.Base64
import android.view.Menu
import android.view.MenuItem
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import cz.homeapp.android.databinding.ActivityMainBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: ServerPrefs

    private val setupLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (!prefs.hasAnyServer()) {
            finish()
            return@registerForActivityResult
        }
        if (result.resultCode == RESULT_OK) {
            loadEntryFromServer()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        prefs = ServerPrefs(this)
        setSupportActionBar(binding.toolbar)

        initWebView()

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (binding.webView.canGoBack()) {
                        binding.webView.goBack()
                    } else {
                        finish()
                    }
                }
            }
        )

        if (!prefs.hasAnyServer()) {
            setupLauncher.launch(Intent(this, SetupActivity::class.java))
        } else {
            loadEntryFromServer()
        }
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main_menu, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.action_reload -> {
                binding.webView.reload()
                true
            }
            R.id.action_server_settings -> {
                setupLauncher.launch(Intent(this, SetupActivity::class.java))
                true
            }
            else -> super.onOptionsItemSelected(item)
        }
    }

    private fun initWebView() {
        val wv = binding.webView
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true)

        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = true
            displayZoomControls = false
        }

        wv.webChromeClient = WebChromeClient()
        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                return false
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                val u = url ?: return
                if (u.contains("login.html", ignoreCase = true)) {
                    injectAutoLoginIfNeeded(view)
                }
            }
        }
    }

    private fun loadEntryFromServer() {
        lifecycleScope.launch {
            val base = withContext(Dispatchers.IO) { prefs.resolveWorkingBaseUrl() }
            val start = UrlBuilder.joinPath(base, "/login.html")
            binding.webView.loadUrl(start)
        }
    }

    private fun injectAutoLoginIfNeeded(view: WebView?) {
        val credJson = prefs.getCredentialsJsonOrNull() ?: return
        val b64 = Base64.encodeToString(
            credJson.toByteArray(Charsets.UTF_8),
            Base64.NO_WRAP
        )
        val script = """
            (async function(b64){
              if (window.__homeappAndroidAutoLoginDone) return;
              window.__homeappAndroidAutoLoginDone = true;
              try {
                var me = await fetch('/api/auth/me', {credentials:'include'});
                if (me.ok) { window.location.replace('/'); return; }
                var creds = JSON.parse(atob(b64));
                if (!creds.username || !creds.password) return;
                var r = await fetch('/api/auth/login', {
                  method: 'POST',
                  headers: {'Content-Type': 'application/json'},
                  credentials: 'include',
                  body: JSON.stringify(creds)
                });
                var j = await r.json();
                if (j && j.ok) window.location.replace('/');
              } catch(e) {}
            })('$b64');
        """.trimIndent()
        view?.evaluateJavascript(script, null)
    }
}
