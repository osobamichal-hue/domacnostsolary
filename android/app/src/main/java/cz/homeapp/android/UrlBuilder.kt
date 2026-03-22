package cz.homeapp.android

import android.net.Uri

object UrlBuilder {

    fun buildBaseUrl(hostInput: String, portInput: String): String {
        val raw = hostInput.trim()
        if (raw.isEmpty()) return ""
        val portStr = portInput.trim().ifEmpty { "3000" }
        val portOverride = portStr.toIntOrNull()

        return if (raw.contains("://")) {
            val uri = Uri.parse(raw)
            val scheme = uri.scheme ?: "http"
            val host = uri.host
            if (host.isNullOrBlank()) return ""
            val existingPort = uri.port
            val usePort = when {
                portInput.trim().isNotEmpty() -> portOverride ?: existingPort.takeIf { it != -1 } ?: 3000
                existingPort != -1 -> existingPort
                else -> portOverride ?: 3000
            }
            "$scheme://$host:$usePort"
        } else {
            val port = portOverride ?: 3000
            "http://${raw.trimEnd('/')}:$port"
        }
    }

    fun joinPath(base: String, path: String): String {
        val b = base.trimEnd('/')
        val p = if (path.startsWith("/")) path else "/$path"
        return "$b$p"
    }
}
