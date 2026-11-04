package com.scantomake.counterpart

import com.scantomake.counterpart.core.Hex
import com.scantomake.counterpart.core.arr
import com.scantomake.counterpart.core.num
import com.scantomake.counterpart.core.obj
import com.scantomake.counterpart.core.parseObject
import com.scantomake.counterpart.core.str
import com.scantomake.counterpart.pairing.CompanionAddress
import com.scantomake.counterpart.pairing.CompanionTrust
import com.scantomake.counterpart.pairing.NearbyCrypto
import com.scantomake.counterpart.pairing.PairingInvitation
import com.scantomake.counterpart.pairing.PairingLink
import com.scantomake.counterpart.pairing.PairingLinkError
import com.scantomake.counterpart.pairing.PairingLinkException
import com.scantomake.counterpart.pairing.PairingRecord
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Base64

/** Pairing links, records, pins and nearby crypto, against the shared contract vectors. */
class PairingLinkTests {
    @Test fun everyVectorTheTypeScriptParserAnswers() {
        val cases = parseObject(contractFixture("pairing-link-vectors.json").readText())!!["cases"].arr!!
        assertTrue(cases.size > 100)
        var checked = 0
        for (item in cases) {
            val o = item.obj!!
            val link = o["link"].str!!
            val now = o["now"].num?.toLong()
            val context = "$link now=$now"
            val expected = o["parsed"].obj
            try {
                val parsed = PairingLink.parse(link, now)
                assertNotNull("Kotlin accepted what TS refused: $context (${o["error"].str})", expected)
                when (parsed) {
                    is PairingLink.V1 -> {
                        assertEquals(context, 1.0, expected!!["version"].num)
                        assertEquals(context, expected["baseUrl"].str, parsed.baseUrl)
                        assertEquals(context, expected["code"].str, parsed.code)
                        assertEquals(context, expected["expiresAt"].num?.toLong(), parsed.expiresAt)
                        assertEquals(context, expected["certificateSha256"].str, parsed.certificateSha256)
                    }
                    is PairingLink.V2 -> {
                        assertEquals(context, 2.0, expected!!["version"].num)
                        assertEquals(context, expected["addresses"].arr!!.map { it.str }, parsed.addresses)
                        assertEquals(context, expected["code"].str, parsed.code)
                        assertEquals(context, expected["expiresAt"].num?.toLong(), parsed.expiresAt)
                        assertEquals(context, expected["publicKeySha256"].str, parsed.publicKeySha256)
                        assertEquals(context, expected["name"].str, parsed.name)
                    }
                }
            } catch (e: PairingLinkException) {
                assertNull("Kotlin refused what TS accepted: $context (${e.error.code})", expected)
                assertEquals(context, o["error"].str, e.error.code)
            }
            checked++
        }
        assertEquals(cases.size, checked)
    }

    @Test fun legacyJsonInvitation() {
        val ok = PairingInvitation.parse("""{"version":1,"baseUrl":"https://mac.tail1234.ts.net","code":"${"C".repeat(32)}","expiresAt":1800000300000}""", now = 1800000000000)
        assertEquals("https://mac.tail1234.ts.net", ok.baseUrl)
        try { PairingInvitation.parse("""{"version":1,"baseUrl":"https://192.168.1.2","code":"${"C".repeat(32)}","expiresAt":1800000300000}""", now = 0); fail() }
        catch (e: PairingLinkException) { assertEquals(PairingLinkError.Invalid, e.error) }
        try { PairingInvitation.parse("""{"version":1,"baseUrl":"https://mac.tail1234.ts.net","code":"${"C".repeat(32)}","expiresAt":10}""", now = 1000); fail() }
        catch (e: PairingLinkException) { assertEquals(PairingLinkError.Expired, e.error) }
    }
}

class PairingRecordTests {
    @Test fun validV2RecordAndAddresses() {
        val record = v2Record()
        assertTrue(record.isValid)
        assertEquals("https://192.168.68.123:9077", record.requestBaseURL)
        assertEquals(ADDRESSES, record.attemptOrder)
        val moved = v2Record(active = ADDRESSES[2])
        assertTrue(moved.isValid)
        assertEquals("https://100.101.102.103:9077", moved.requestBaseURL)
        assertEquals(listOf(ADDRESSES[2], ADDRESSES[0], ADDRESSES[1]), moved.attemptOrder)
        assertTrue("which address answered doesn't make it another pairing", record.isSamePairing(moved))
        assertFalse(v2Record(active = "https://10.0.0.1:9077").isValid)
        assertFalse(record.with("token", JsonPrimitive("short")).isValid)
        assertFalse(record.with("protocolVersion", JsonPrimitive("0.2.0")).isValid)
        assertFalse(record.with("scopes", com.scantomake.counterpart.core.toJson(listOf("projects:read", "projects:write"))).isValid)
    }

    @Test fun addressRules() {
        val pin = "0".repeat(64)
        assertEquals("https://192.168.1.2:9077", CompanionAddress.pinnedBaseURL("https://192.168.1.2:9077/", pin))
        assertEquals("https://davids-mac.local:9077", CompanionAddress.pinnedBaseURL("https://davids-mac.local:9077", pin))
        assertNull("public names are never pinned", CompanionAddress.pinnedBaseURL("https://example.com", pin))
        assertNull(CompanionAddress.pinnedBaseURL("http://192.168.1.2:9077", pin))
        assertNull(CompanionAddress.pinnedBaseURL("https://user@192.168.1.2", pin))
        assertNull(CompanionAddress.pinnedBaseURL("https://192.168.1.2/path", pin))
        assertEquals("https://mac.tail1234.ts.net", CompanionAddress.companionBaseURL("https://mac.tail1234.ts.net/"))
        assertNull(CompanionAddress.companionBaseURL("https://mac.tail1234.ts.net:8443"))
        assertNull(CompanionAddress.companionBaseURL("https://example.com"))
        assertTrue(CompanionAddress.tryNext("certificate"))
        assertFalse(CompanionAddress.tryNext("unauthorized"))
    }
}

class TrustTests {
    private val certs = parseObject(kitFixture("certificates.json").readText())!!

    @Test fun publicKeyPinsMatchOpenSSL() {
        for (kind in listOf("rsa", "ec")) {
            val one = certs[kind].obj!!
            val der = kitFixture(one["certificate"].str!!).readBytes()
            assertEquals(one["publicKeySha256"].str, CompanionTrust.publicKeySha256(der))
            assertEquals(one["certificateSha256"].str, Hex.sha256(der))
            // The same bytes Java's own certificate parser gives as the encoded public key (what Android's TLS stack sees).
            val x509 = java.security.cert.CertificateFactory.getInstance("X.509").generateCertificate(der.inputStream()) as java.security.cert.X509Certificate
            assertEquals(one["publicKeySha256"].str, Hex.sha256(x509.publicKey.encoded))
            var cut = 0
            while (cut < der.size) { CompanionTrust.subjectPublicKeyInfo(der.copyOf(cut)); cut += 37 }
        }
        assertNull(CompanionTrust.subjectPublicKeyInfo(ByteArray(0)))
        assertNull(CompanionTrust.subjectPublicKeyInfo(byteArrayOf(0x30, 0x84.toByte(), 0xff.toByte(), 0xff.toByte(), 0xff.toByte(), 0xff.toByte())))
    }

    @Test fun pinnedTrustNeedsTheKeyOnItsOwnHostAndPort() {
        val ec = certs["ec"].obj!!
        val der = kitFixture(ec["certificate"].str!!).readBytes()
        val rsa = kitFixture(certs["rsa"].obj!!["certificate"].str!!).readBytes()
        val record = v2Record().with("publicKeySha256", JsonPrimitive(ec["publicKeySha256"].str!!))
        assertTrue(CompanionTrust.accepts(record, "192.168.68.123", 9077, der))
        assertTrue(CompanionTrust.accepts(record, "192.168.68.123".uppercase(), 9077, der))
        assertFalse("another host", CompanionTrust.accepts(record, "192.168.68.124", 9077, der))
        assertFalse("another port", CompanionTrust.accepts(record, "192.168.68.123", 9078, der))
        assertFalse("another key", CompanionTrust.accepts(record, "192.168.68.123", 9077, rsa))
        assertFalse(CompanionTrust.accepts(record, "192.168.68.123", 9077, null))
        val v1 = PairingRecord(mapOf("baseUrl" to JsonPrimitive("https://192.168.1.20"), "certificateSha256" to JsonPrimitive(certs["rsa"].obj!!["certificateSha256"].str!!)))
        assertTrue("port 0 means 443", CompanionTrust.accepts(v1, "192.168.1.20", 0, rsa))
    }

    @Test fun nearbyTrustOnFirstUse() {
        val der = kitFixture(certs["ec"].obj!!["certificate"].str!!).readBytes()
        val rsa = kitFixture(certs["rsa"].obj!!["certificate"].str!!).readBytes()
        val base = "https://192.168.1.5:9077"
        val first = NearbyCrypto.trust("192.168.1.5", 9077, der, base, null)!!
        assertEquals(certs["ec"].obj!!["publicKeySha256"].str, Hex.string(first))
        assertNotNull(NearbyCrypto.trust("192.168.1.5", 9077, der, base, first))
        assertNull("only the first key after that", NearbyCrypto.trust("192.168.1.5", 9077, rsa, base, first))
        assertNull(NearbyCrypto.trust("192.168.1.6", 9077, der, base, null))
    }

    @Test fun nearbyVector() {
        val v = parseObject(contractFixture("nearby-pairing-v1.json").readText())!!
        val s = Hex.bytes(v["publicKeySha256"].str!!)!!
        val key = NearbyCrypto.bytes(v["key"].str)!!
        val nonce = NearbyCrypto.bytes(v["nonce"].str)!!
        assertEquals(v["commit"].str, NearbyCrypto.base64URL(NearbyCrypto.commit(key)!!))
        assertEquals(v["code"].str, NearbyCrypto.code(s, key, nonce))
        assertEquals("527 980", NearbyCrypto.display("527980"))
        assertNull("not canonical", NearbyCrypto.bytes(v["key"].str!!.dropLast(1) + "B"))
        assertEquals(32, Base64.getUrlDecoder().decode(v["key"].str).size)
    }
}
