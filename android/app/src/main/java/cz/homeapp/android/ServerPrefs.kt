package cz.homeapp.android

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import org.json.JSONObject

class ServerPrefs(context: Context) {

    private val appContext = context.applicationContext

    private val prefs by lazy {
        val masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
        EncryptedSharedPreferences.create(
            PREFS_NAME,
            masterKeyAlias,
            appContext,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    fun getUsername(): String = prefs.getString(K_USERNAME, "") ?: ""

    fun getInternalHost(): String = prefs.getString(K_INTERNAL_HOST, "") ?: ""
    fun getInternalPort(): String = prefs.getString(K_INTERNAL_PORT, "3000") ?: "3000"
    fun getPublicHost(): String = prefs.getString(K_PUBLIC_HOST, "") ?: ""
    fun getPublicPort(): String = prefs.getString(K_PUBLIC_PORT, "3000") ?: "3000"
    fun isPreferInternalFirst(): Boolean = prefs.getBoolean(K_PREFER_INTERNAL, true)
    fun isRememberLogin(): Boolean = prefs.getBoolean(K_REMEMBER, true)

    fun hasAnyServer(): Boolean {
        val i = UrlBuilder.buildBaseUrl(getInternalHost(), getInternalPort())
        val p = UrlBuilder.buildBaseUrl(getPublicHost(), getPublicPort())
        return i.isNotEmpty() || p.isNotEmpty()
    }

    /**
     * Vybere první dostupnou základní URL podle priority a /api/health.
     * Pokud nic neodpoví, vrátí první nakonfigurovanou (WebView ukáže chybu).
     */
    fun resolveWorkingBaseUrl(): String {
        val internal = UrlBuilder.buildBaseUrl(getInternalHost(), getInternalPort())
        val public = UrlBuilder.buildBaseUrl(getPublicHost(), getPublicPort())
        val candidates = if (isPreferInternalFirst()) {
            listOfNotNull(
                internal.takeIf { it.isNotEmpty() },
                public.takeIf { it.isNotEmpty() }
            )
        } else {
            listOfNotNull(
                public.takeIf { it.isNotEmpty() },
                internal.takeIf { it.isNotEmpty() }
            )
        }
        for (url in candidates) {
            if (HealthChecker.pingHealth(url)) return url
        }
        return candidates.firstOrNull() ?: "http://127.0.0.1:3000"
    }

    /**
     * @param passwordNew nové heslo, nebo null = při zapnutém „Pamatovat“ ponechat dříve uložené
     */
    fun save(
        internalHost: String,
        internalPort: String,
        publicHost: String,
        publicPort: String,
        preferInternal: Boolean,
        username: String,
        passwordNew: String?,
        remember: Boolean
    ) {
        val ed = prefs.edit()
            .putString(K_INTERNAL_HOST, internalHost.trim())
            .putString(K_INTERNAL_PORT, internalPort.trim().ifEmpty { "3000" })
            .putString(K_PUBLIC_HOST, publicHost.trim())
            .putString(K_PUBLIC_PORT, publicPort.trim().ifEmpty { "3000" })
            .putBoolean(K_PREFER_INTERNAL, preferInternal)
            .putBoolean(K_REMEMBER, remember)
            .putString(K_USERNAME, username.trim())
        if (!remember) {
            ed.remove(K_PASSWORD)
        } else if (passwordNew != null) {
            ed.putString(K_PASSWORD, passwordNew)
        }
        ed.apply()
    }

    /** JSON pro POST /api/auth/login, nebo null pokud auto-login vypnutý / prázdné. */
    fun getCredentialsJsonOrNull(): String? {
        if (!isRememberLogin()) return null
        val u = prefs.getString(K_USERNAME, "") ?: ""
        val p = prefs.getString(K_PASSWORD, null)
        if (u.isEmpty() || p.isNullOrEmpty()) return null
        return JSONObject().put("username", u).put("password", p).toString()
    }

    companion object {
        private const val PREFS_NAME = "homeapp_server_secure"
        private const val K_INTERNAL_HOST = "internal_host"
        private const val K_INTERNAL_PORT = "internal_port"
        private const val K_PUBLIC_HOST = "public_host"
        private const val K_PUBLIC_PORT = "public_port"
        private const val K_PREFER_INTERNAL = "prefer_internal"
        private const val K_REMEMBER = "remember_login"
        private const val K_USERNAME = "username"
        private const val K_PASSWORD = "password"
    }
}
