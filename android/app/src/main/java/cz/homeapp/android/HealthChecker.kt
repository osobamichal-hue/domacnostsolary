package cz.homeapp.android

import java.net.HttpURLConnection
import java.net.URL

object HealthChecker {

    fun pingHealth(baseUrl: String, timeoutMs: Int = 2800): Boolean {
        val base = baseUrl.trimEnd('/')
        if (base.isEmpty()) return false
        return try {
            val u = URL("$base/api/health")
            val c = u.openConnection() as HttpURLConnection
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
            c.requestMethod = "GET"
            c.instanceFollowRedirects = true
            val code = c.responseCode
            c.disconnect()
            code in 200..299
        } catch (_: Exception) {
            false
        }
    }
}
