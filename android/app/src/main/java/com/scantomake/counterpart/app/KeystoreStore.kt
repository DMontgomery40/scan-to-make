package com.scantomake.counterpart.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.scantomake.counterpart.pairing.SecureStore
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The Android counterpart of the iPhone Keychain items (`current`, `installation`): AES-GCM with a key that never
 * leaves the Android Keystore, ciphertext in private SharedPreferences. Excluded from backups (see the manifest).
 */
// commit(), not apply(): the pairing must be on disk before the app goes on to use it.
@android.annotation.SuppressLint("ApplySharedPref")
class KeystoreStore(context: Context) : SecureStore {
    private val prefs = context.getSharedPreferences("org.scantomake.companion.v1", Context.MODE_PRIVATE)
    private val alias = "org.scantomake.companion.v1"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        return generator.generateKey()
    }

    @Synchronized override fun read(account: String): ByteArray? {
        val stored = prefs.getString(account, null) ?: return null
        return try {
            val raw = Base64.decode(stored, Base64.NO_WRAP)
            if (raw.size < 13) throw IllegalStateException("short")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12))
            cipher.doFinal(raw, 12, raw.size - 12)
        } catch (_: Exception) {
            // The Keystore key is gone (a restore to another phone, a wiped lock screen): the item can never be read
            // again, so drop it. The phone pairs again; a new installation key just looks like a new phone.
            prefs.edit().remove(account).commit()
            null
        }
    }

    @Synchronized override fun write(account: String, data: ByteArray) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val out = cipher.iv + cipher.doFinal(data)
        prefs.edit().putString(account, Base64.encodeToString(out, Base64.NO_WRAP)).commit()
    }

    @Synchronized override fun add(account: String, data: ByteArray): Boolean {
        if (prefs.contains(account)) return false
        write(account, data); return true
    }

    @Synchronized override fun delete(account: String) { prefs.edit().remove(account).commit() }
}
