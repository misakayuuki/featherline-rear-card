package com.mkx.hrttracker.rearcard

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Opt-in export of an intentionally small rear-display projection through bridge API 2. */
class RearCardPublisher private constructor(private val context: Context) {
    private val preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val stateLock = Any()
    private val operationMutex = Mutex()
    @Volatile private var enabled = preferences.getBoolean("enabled", false)
    private var generation = 0L
    // This extra display cache never reaches disk. The source's encrypted snapshot remains canonical.
    private var latest: ByteArray? = null
    @Volatile private var statusText = if (enabled) "等待 Featherline 更新背屏数据" else "背屏同步未开启"

    val isEnabled: Boolean get() = enabled
    val lastStatus: String get() = statusText

    data class Result(val status: String, val message: String) {
        val saved: Boolean get() = status in setOf("SAVED", "BINDING_REQUIRED", "CARRIER_WRITTEN")
        val bindingRequired: Boolean get() = status == "BINDING_REQUIRED"
    }

    data class Prepared internal constructor(
        val file: File,
        val uri: Uri,
        val requestId: String,
        internal val generation: Long,
    )

    fun isBridgeInstalled(): Boolean = try {
        context.packageManager.getApplicationInfo(BRIDGE_PACKAGE, 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    /** Caller then refreshes WidgetSnapshotRepository and calls prepareForeground(). */
    suspend fun enable(): Result {
        val ticket = changeEnabled(true)
        return withContext(Dispatchers.IO) {
            operationMutex.withLock {
                if (!isCurrent(ticket, true)) return@withLock superseded()
                eraseLatest()
                report(ticket, Result("ENABLED", "已开启，正在准备 Featherline 背屏数据"))
            }
        }
    }

    /** Widget publications may call this even if the bridge is missing; source-app work still succeeds. */
    suspend fun publish(payload: JSONObject): Result {
        val ticket = synchronized(stateLock) { if (enabled) generation else null }
            ?: return Result("DISABLED", "背屏同步未开启")
        val bytes = try {
            payload.toString().toByteArray(Charsets.UTF_8)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            return report(ticket, Result("INVALID_PAYLOAD", "背屏数据暂不可用"))
        }
        if (bytes.size > MAX_PAYLOAD_BYTES) {
            bytes.fill(0)
            return report(ticket, Result("PAYLOAD_TOO_LARGE", "背屏数据过大，本次未同步"))
        }
        try {
            return withContext(Dispatchers.IO) {
                operationMutex.withLock {
                    if (!isCurrent(ticket, true)) return@withLock superseded()
                    eraseLatest()
                    latest = bytes.copyOf()
                    if (!isCurrent(ticket, true)) return@withLock superseded()
                    val result = publishBytes(bytes, ticket)
                    report(ticket, result)
                }
            }
        } finally {
            bytes.fill(0)
        }
    }

    /** Creates an explicit foreground binding import after a fresh widget publication. */
    suspend fun prepareForeground(): Prepared? = withContext(Dispatchers.IO) {
        operationMutex.withLock {
            val ticket = synchronized(stateLock) { if (enabled) generation else null } ?: return@withLock null
            val data = latest ?: return@withLock null
            try {
                val prepared = buildZip(data, ticket)
                if (!isCurrent(ticket, true)) {
                    cleanupUri(prepared.uri)
                    null
                } else prepared
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                report(ticket, Result("ERROR", "无法准备背屏模块，请稍后重试"))
                null
            }
        }
    }

    fun foregroundIntent(prepared: Prepared): Intent {
        check(isCurrent(prepared.generation, true)) { "背屏同步状态已改变，请重新连接" }
        return Intent("dev.finall.rearcardbridge.action.UPDATE_CONTENT").apply {
            setPackage(BRIDGE_PACKAGE)
            setDataAndType(prepared.uri, "application/zip")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            clipData = ClipData.newRawUri("Featherline rear card", prepared.uri)
            putExtra("api_version", 2)
            putExtra("request_id", prepared.requestId)
        }
    }

    /**
     * Disables admission before waiting for an in-flight publish, then writes a null payload last.
     * Finishing local erasure/remote clearing is not abandoned when the settings screen closes.
     */
    suspend fun disableAndClear(): Result {
        val ticket = changeEnabled(false)
        return withContext(NonCancellable + Dispatchers.IO) {
            operationMutex.withLock {
                if (!isCurrent(ticket, false)) return@withLock superseded()
                eraseLatest()
                clearPendingExports()
                val result = publishBytes(null, ticket)
                val message = when {
                    result.saved -> "同步已关闭，已向卡片桥发送清空内容；背屏将在系统下次读取时更新"
                    else -> "同步已关闭，本地数据已清除；卡片桥清空未确认，请在卡片桥移除本模块"
                }
                report(ticket, result.copy(message = message))
            }
        }
    }

    /** Can be called using a saved URI after Activity recreation. */
    fun cleanupUri(uri: Uri?) {
        if (uri == null || uri.scheme != "content" || uri.authority != authority(context)
            || uri.query != null || uri.fragment != null) return
        val parts = uri.pathSegments
        if (parts.size != 2 || parts[0] != "module" || !EXPORT_NAME.matches(parts[1])) return
        try {
            val root = exportDirectory(context).canonicalFile
            val file = File(root, parts[1]).canonicalFile
            if (file.parentFile != root) return
            context.revokeUriPermission(BRIDGE_PACKAGE, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            if (file.isFile) file.delete()
        } catch (_: IOException) {
            // No payload or URI is logged. A later explicit clear can remove the file.
        } catch (_: SecurityException) {
            // A revoked grant cannot be used to read the file.
        }
    }

    fun recordForegroundResult(extras: Bundle?): Result {
        val result = resultFromBundle(extras)
        synchronized(stateLock) { if (enabled) statusText = result.message }
        return result
    }

    private fun changeEnabled(value: Boolean): Long = synchronized(stateLock) {
        generation += 1
        enabled = value
        preferences.edit().putBoolean("enabled", value).apply()
        generation
    }

    private fun isCurrent(ticket: Long, expectedEnabled: Boolean): Boolean = synchronized(stateLock) {
        generation == ticket && enabled == expectedEnabled
    }

    private fun report(ticket: Long, result: Result): Result {
        synchronized(stateLock) { if (generation == ticket) statusText = result.message }
        return result
    }

    private fun eraseLatest() {
        latest?.fill(0)
        latest = null
    }

    private fun clearPendingExports() {
        exportDirectory(context).listFiles()?.forEach { file ->
            if (file.isFile && EXPORT_NAME.matches(file.name)) cleanupUri(exportUri(context, file))
        }
    }

    private fun publishBytes(bytes: ByteArray?, ticket: Long): Result {
        var prepared: Prepared? = null
        try {
            if (!isBridgeInstalled()) return Result("BRIDGE_MISSING", "请先安装卡片桥，再到此处连接")
            prepared = buildZip(bytes, ticket)
            if (!isCurrent(ticket, bytes != null)) return superseded()
            context.grantUriPermission(BRIDGE_PACKAGE, prepared.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            val extras = Bundle().apply {
                putInt("api_version", 2)
                putParcelable("package_uri", prepared.uri)
                putString("request_id", prepared.requestId)
            }
            val result = context.contentResolver.call(
                Uri.parse("content://$BRIDGE_PACKAGE.update"), "update_content", null, extras,
            )
            return resultFromBundle(result)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: SecurityException) {
            return Result("URI_PERMISSION_DENIED", "卡片桥无法读取本次模块，请重新连接")
        } catch (_: IllegalArgumentException) {
            return Result("API_UNAVAILABLE", "卡片桥接口不可用，请更新卡片桥")
        } catch (_: Exception) {
            return Result("ERROR", "同步未确认完成，请在卡片桥检查")
        } finally {
            prepared?.let { cleanupUri(it.uri) }
        }
    }

    private fun buildZip(bytes: ByteArray?, ticket: Long): Prepared {
        val directory = exportDirectory(context)
        if (!directory.isDirectory && !directory.mkdirs()) throw IOException("Export directory unavailable")
        val id = UUID.randomUUID().toString()
        val file = File(directory, "$id.zip")
        try {
            val json = bytes?.toString(Charsets.UTF_8) ?: "null"
            val data = "window.FEATHERLINE_PAYLOAD = " + json.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029") + ";\n"
            ZipOutputStream(file.outputStream().buffered()).use { zip ->
                fun asset(name: String, target: String) {
                    zip.putNextEntry(ZipEntry(target))
                    context.assets.open("rearcard/$name").use { it.copyTo(zip) }
                    zip.closeEntry()
                }
                fun assetTree(name: String, target: String) {
                    // The host supplies this API; never shadow it with a bundled copy.
                    if (name.substringAfterLast('/') == "bridge-shim.js") return
                    if (target == "card/data.js") return
                    val children = context.assets.list("rearcard/$name").orEmpty().sorted()
                    if (children.isEmpty()) {
                        asset(name, target)
                    } else {
                        children.forEach { child -> assetTree("$name/$child", "$target/$child") }
                    }
                }
                context.assets.list("rearcard").orEmpty().sorted().forEach { name ->
                    // Card resources remain flat in app assets; WebView resources retain
                    // their webroot/ prefix. Include future module files automatically.
                    val target = if (name in setOf("module.json", "icon.png", "webroot", "background")) {
                        name
                    } else {
                        "card/$name"
                    }
                    assetTree(name, target)
                }
                zip.putNextEntry(ZipEntry("card/data.js"))
                zip.write(data.toByteArray(Charsets.UTF_8))
                zip.closeEntry()
            }
            return Prepared(file, exportUri(context, file), id, ticket)
        } catch (exception: Exception) {
            file.delete()
            throw exception
        }
    }

    companion object {
        const val PREFS_NAME = "rear_card_preferences"
        const val BRIDGE_PACKAGE = "dev.finall.rearcardbridge"
        const val MAX_PAYLOAD_BYTES = 200_000
        internal val EXPORT_NAME = Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.zip")
        @Volatile private var instance: RearCardPublisher? = null
        fun get(context: Context): RearCardPublisher = instance ?: synchronized(this) {
            instance ?: RearCardPublisher(context.applicationContext).also { instance = it }
        }
        internal fun authority(context: Context) = context.packageName + ".rearcard.exports"
        internal fun exportDirectory(context: Context) = File(context.cacheDir, "rearcard_exports")
        private fun exportUri(context: Context, file: File): Uri = Uri.Builder().scheme("content")
            .authority(authority(context)).appendPath("module").appendPath(file.name).build()
        private fun superseded() = Result("SUPERSEDED", "同步状态已改变，本次操作已取消")

        fun resultFromBundle(reply: Bundle?): Result {
            if (reply == null) return Result("UNKNOWN", "卡片桥未返回结果，请打开卡片桥检查")
            val status = reply.getString("status") ?: "UNKNOWN"
            var message = when (status) {
                "SAVED" -> "数据已保存到卡片桥，背屏显示时间由系统决定"
                "BINDING_REQUIRED" -> "模块已保存，请在卡片桥选择并绑定背屏载体"
                "CARRIER_WRITTEN" -> "载体已写入，请到系统背屏设置重新应用"
                "SETTINGS_OPENED" -> "已打开系统设置，请完成背屏应用"
                "USER_LOCKED" -> "请解锁手机后重新同步"
                "DOWNGRADE_CONFIRMATION_REQUIRED" -> "需要在卡片桥前台确认版本，请重新连接"
                "URI_PERMISSION_DENIED" -> "卡片桥无法读取模块，请重新连接"
                else -> "卡片桥未确认保存，请打开卡片桥检查"
            }
            if (status == "SAVED" && (reply.getBoolean("carrier_update_required", false)
                        || reply.getBoolean("reapply_confirmation_pending", false))) {
                message += "；载体资源需更新或重新应用"
            }
            return Result(status, message)
        }
    }
}
