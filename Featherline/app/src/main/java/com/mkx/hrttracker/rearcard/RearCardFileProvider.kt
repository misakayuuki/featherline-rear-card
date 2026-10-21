package com.mkx.hrttracker.rearcard

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException

/** Only exact UUID ZIPs under this provider's cache directory can be URI-granted. */
class RearCardFileProvider : ContentProvider() {
    override fun onCreate() = true

    private fun resolve(uri: Uri): File {
        val appContext = context ?: throw FileNotFoundException("Provider unavailable")
        val parts = uri.pathSegments
        if (uri.scheme != "content" || uri.authority != RearCardPublisher.authority(appContext)
            || uri.query != null || uri.fragment != null || parts.size != 2 || parts[0] != "module"
            || !RearCardPublisher.EXPORT_NAME.matches(parts[1])) {
            throw FileNotFoundException("Unsupported module URI")
        }
        try {
            val root = RearCardPublisher.exportDirectory(appContext).canonicalFile
            val file = File(root, parts[1]).canonicalFile
            if (file.parentFile != root || !file.isFile) throw FileNotFoundException("Module expired")
            return file
        } catch (_: IOException) {
            throw FileNotFoundException("Module unavailable")
        }
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw FileNotFoundException("Read only")
        return ParcelFileDescriptor.open(resolve(uri), ParcelFileDescriptor.MODE_READ_ONLY)
    }
    override fun getType(uri: Uri): String = "application/zip"
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? {
        val file = try { resolve(uri) } catch (_: FileNotFoundException) { return null }
        val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(columns, 1).apply {
            val row = arrayOfNulls<Any>(columns.size)
            columns.forEachIndexed { index, column ->
                row[index] = when (column) {
                    OpenableColumns.DISPLAY_NAME -> "featherline-rear-card.zip"
                    OpenableColumns.SIZE -> file.length()
                    else -> null
                }
            }
            addRow(row)
        }
    }
    override fun insert(uri: Uri, values: ContentValues?): Uri = throw UnsupportedOperationException("Read only")
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException("Read only")
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException("Read only")
}
