package com.tessera.crossdevice

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/** 本机投递凭据：先记已核对的目的 URI，再删除暂存，跨重启恢复仍幂等。 */
class DeliveryReceipts(context: Context) : SQLiteOpenHelper(context, "delivery-receipts.db", null, 1) {
    data class Receipt(val uri: String, val size: Long, val digest: ByteArray)

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE receipts (source TEXT PRIMARY KEY, tree TEXT NOT NULL, uri TEXT NOT NULL, size INTEGER NOT NULL, digest BLOB NOT NULL)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    fun find(source: String, tree: String): Receipt? = readableDatabase.query(
        "receipts", arrayOf("uri", "size", "digest"), "source=? AND tree=?", arrayOf(source, tree), null, null, null,
    ).use { c -> if (c.moveToFirst()) Receipt(c.getString(0), c.getLong(1), c.getBlob(2)) else null }

    fun save(source: String, tree: String, receipt: Receipt) {
        val values = ContentValues().apply {
            put("source", source); put("tree", tree); put("uri", receipt.uri)
            put("size", receipt.size); put("digest", receipt.digest)
        }
        check(writableDatabase.insertWithOnConflict("receipts", null, values, SQLiteDatabase.CONFLICT_REPLACE) >= 0) {
            "Cannot persist delivery receipt"
        }
    }
}
