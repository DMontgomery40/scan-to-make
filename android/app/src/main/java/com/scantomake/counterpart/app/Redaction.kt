package com.scantomake.counterpart.app

import java.util.Base64

/**
 * What Settings → Share Diagnostics… (#799) removes from every file before it leaves the phone. Written for the phone
 * after the review of the companion's redactor (#813, comment 6886304221) found leaks in it; it is not a port of those
 * rules. In order:
 *  1. the known values (the pairing token, the device id, the pin, the computer's hosts), and a hash in any form
 *     (hex either case, colon-separated, base64, base64url);
 *  2. PEM blocks of any kind, Authorization and Cookie lines, and auth schemes in any case;
 *  3. the value after a secret-looking name (JSON, escaped JSON, `key=value`, `key: value`, `--flag value`), judged
 *     word by word, so `PAIRING_PIN`, `session_key` and `X-Api-Key` count and `pinned` and `keyboard` don't. A value is
 *     kept only when the whole of it is a marker ("", `[set]`, `[redacted…]`, true, false, null);
 *  4. tokens by their shape (JWT, `ghp_`, `github_pat_`, `AKIA`, `AIza`, `sk-`, `hf_`, `xox?-`), DER base64, e-mail
 *     addresses, pairing links, a PIN after "pin", the user's name in a home path, and any 64-hex, base64 SHA-256
 *     or 43-character token run.
 */
object Redaction {
    /** Words that make a name secret wherever they appear inside it (`refreshTokens`, `BAMBU_PASSWORD`). */
    private val STRONG = listOf("password", "passwd", "passphrase", "passcode", "secret", "token", "apikey", "credential",
        "cookie", "privatekey", "accesskey", "accesscode", "sessionkey", "sessionid", "authorization", "authkey")
    /** Words that make a name secret only as a word of their own (`pin`, not `pinned`; `key`, not `keyboard`). */
    private val WORDS = setOf("key", "pin", "pwd", "otp", "sid", "session", "auth", "cert", "certificate", "sha256", "fingerprint",
        "signature", "ticket", "login", "email", "mail", "user", "username", "account", "jwt", "bearer", "cookie", "pass")
    /** `code` is secret after these (`access_code`, `PAIRING_CODE`, `lanCode`), not on its own (an error's code). */
    private val CODE_AFTER = setOf("access", "lan", "pair", "pairing", "auth", "otp", "verification", "nearby", "one", "confirm", "confirmation", "pin")

    /** Whether a name says its value is a secret. */
    fun secretName(name: String): Boolean {
        val decoded = Regex("""\\u([0-9a-fA-F]{4})""").replace(name) { it.groupValues[1].toInt(16).toChar().toString() }
        val words = decoded.replace(Regex("""(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])"""), " ")
            .lowercase().split(Regex("""[^a-z0-9]+""")).filter { it.isNotEmpty() }
        val joined = words.joinToString("")
        if (STRONG.any { joined.contains(it) }) return true
        // Plurals count too (`keys`, `pins`); "access" stays "access".
        fun word(w: String, set: Set<String>) = w in set || (w.endsWith("s") && w.dropLast(1) in set)
        if (words.any { word(it, WORDS) }) return true
        return words.withIndex().any { (i, w) -> word(w, setOf("code")) && i > 0 && word(words[i - 1], CODE_AFTER) }
    }

    private val MARKER = Regex("""(?:"|\\")?(?:\[set]|\[redacted[^"\]]*]|)(?:"|\\")?|true|false|null""")
    /** A value that only says whether a secret is configured, and nothing more. */
    private fun safe(value: String) = (value.isEmpty() || MARKER.matches(value)) &&
        !(value.startsWith("\"") xor value.endsWith("\"")) && value != "\"" && value != "\\\""

    /** Every form a known value can take: a 64-hex hash also as upper case, colon pairs, base64 and base64url. */
    fun forms(secret: String): List<String> {
        if (!Regex("[0-9a-fA-F]{64}").matches(secret)) return listOf(secret)
        val lower = secret.lowercase()
        val bytes = lower.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        return listOf(lower, lower.uppercase(), lower.chunked(2).joinToString(":"), lower.uppercase().chunked(2).joinToString(":"),
            Base64.getEncoder().encodeToString(bytes), Base64.getUrlEncoder().withoutPadding().encodeToString(bytes))
    }

    private val VALUE = """"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s,;&}"']+"""
    /** Before the key=value pass: blocks, headers, schemes, URL credentials, JSON and --flags. */
    private val NAMED: List<Pair<Regex, (MatchResult) -> String>> = listOf(
        // PEM blocks of any kind (certificates, private keys, OpenSSH keys), escaped newlines too.
        Regex("""-----BEGIN ([A-Z0-9 ]{1,40})-----[\s\S]*?(?:-----END \1-----|$)""") to { _ -> "[redacted PEM block]" },
        // Authorization and Cookie header lines, whole.
        Regex("""^([ \t]*(?:proxy-)?authorization[ \t]*[:=]).*$""", setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE)) to { m -> "${m.groupValues[1]} [redacted]" },
        Regex("""^([ \t]*(?:set-)?cookie[ \t]*:).*$""", setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE)) to { m -> "${m.groupValues[1]} [redacted]" },
        // Auth schemes anywhere, in any case.
        Regex("""\b(bearer|basic|digest|negotiate|token)(\s+)[A-Za-z0-9._~+/=-]{6,}""", RegexOption.IGNORE_CASE) to { m -> "${m.groupValues[1]}${m.groupValues[2]}[redacted]" },
        // scheme://user:password@host keeps its host.
        Regex("""\b([a-z][a-z0-9+.-]*://)[^/\s:@"'<>]+(?::[^/\s@"'<>]*)?@""", RegexOption.IGNORE_CASE) to { m -> "${m.groupValues[1]}[redacted]@" },
        // Escaped JSON inside a string: \"accessCode\":\"1234\".
        Regex("""(\\"((?:[^"\\]|\\u[0-9a-fA-F]{4}){1,200})\\"\s*:\s*)(\\"(?:[^"\\]|\\[^"])*\\"|[^\s,}\]\\]+)""") to { m ->
            if (secretName(m.groupValues[2]) && !safe(m.groupValues[3])) "${m.groupValues[1]}\\\"[redacted]\\\"" else m.value },
        // JSON: "accessCode": "1234", a number or a bare word too (an object or array is read inside instead).
        Regex(""""((?:[^"\\\n]|\\.){1,200})"(\s*:\s*)("(?:[^"\\\n]|\\.)*"|[^\s,}\]{\["][^\s,}\]]*)""") to { m ->
            if (secretName(m.groupValues[1]) && !safe(m.groupValues[3])) "\"${m.groupValues[1]}\"${m.groupValues[2]}\"[redacted]\"" else m.value },
        // --flag value and --flag=value.
        Regex("""(?<![A-Za-z0-9])--([A-Za-z][A-Za-z0-9_.-]{0,100})([ \t]+|=)($VALUE)""") to { m ->
            if (secretName(m.groupValues[1]) && !safe(m.groupValues[3])) "--${m.groupValues[1]}${m.groupValues[2]}[redacted]" else m.value },
    )
    /** After the key=value pass: values by their own shape, wherever they are. */
    private val SHAPES: List<Pair<Regex, (MatchResult) -> String>> = listOf(
        // Tokens by their shape.
        Regex("""\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+""") to { _ -> "[redacted token]" },
        Regex("""\bgh[pousr]_[A-Za-z0-9]{20,}""") to { _ -> "[redacted token]" },
        Regex("""\bgithub_pat_[A-Za-z0-9_]{20,}""") to { _ -> "[redacted token]" },
        Regex("""\b(?:AKIA|ASIA)[A-Z0-9]{16}\b""") to { _ -> "[redacted key]" },
        Regex("""\bAIza[0-9A-Za-z_-]{30,}""") to { _ -> "[redacted key]" },
        Regex("""\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}""") to { _ -> "[redacted key]" },
        Regex("""\bhf_[A-Za-z0-9]{20,}""") to { _ -> "[redacted token]" },
        Regex("""\bxox[abposr]-[A-Za-z0-9-]{10,}""") to { _ -> "[redacted token]" },
        // A certificate or key as bare DER base64.
        Regex("""\bMI[A-Za-z0-9+/]{60,}={0,2}""") to { _ -> "[redacted certificate or key]" },
        // E-mail addresses (an account).
        Regex("""[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}""") to { _ -> "[redacted email]" },
        // A pairing link carries its code.
        Regex("""scantomake://pair\?[^\s"']+""", RegexOption.IGNORE_CASE) to { _ -> "scantomake://pair?[redacted]" },
        // A PIN in words: "PIN 482913", "pairing code is 482913".
        Regex("""\b(pin|passcode|(?:pairing|nearby|access) code)(\s+(?:is\s+)?#?)\d{4,8}\b""", RegexOption.IGNORE_CASE) to { m -> "${m.groupValues[1]}${m.groupValues[2]}[redacted]" },
        // The user's name in a home path: /Users/<name>, /home/<name>, C:\Users\<name>, escaped slashes, ~name/.
        Regex("""((?:/|\\/|\\\\|\\)(?:Users|home)(?:/|\\/|\\\\|\\))[^/\\\s"'<>:]+""", RegexOption.IGNORE_CASE) to { m -> "${m.groupValues[1]}[user]" },
        Regex("""(?<![A-Za-z0-9_])~[A-Za-z][A-Za-z0-9._-]*(?=/|\\)""") to { _ -> "~[user]" },
        // Hashes and tokens in any form: 64 hex, colon pairs, base64 SHA-256, a 43-character token.
        Regex("""\b[a-fA-F0-9]{64}\b""") to { _ -> "[redacted hash]" },
        Regex("""\b(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}\b""") to { _ -> "[redacted hash]" },
        Regex("""(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{43}=""") to { _ -> "[redacted hash]" },
        Regex("""(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])""") to { _ -> "[redacted token]" },
    )

    private val KEY = Regex("""(?<![A-Za-z0-9_.\-])([A-Za-z][A-Za-z0-9_.\-]{0,100})([ \t]*(?:=|:(?!//))[ \t]*)""")
    private val VALUE_AT = Regex(VALUE)

    /**
     * key=value, key: value, ?key=value&, #key=value. Found name by name: a harmless name (`https:`, `note:`) never
     * swallows what follows it, so `note: password=x` and `https://h/?access_token=x` are still read.
     */
    private fun keyValues(text: String): String {
        val out = StringBuilder()
        var at = 0
        while (true) {
            val key = KEY.find(text, at) ?: break
            out.append(text, at, key.range.last + 1)
            at = key.range.last + 1
            if (!secretName(key.groupValues[1])) continue
            val value = VALUE_AT.matchAt(text, at) ?: continue
            out.append(if (safe(value.value)) value.value else "[redacted]")
            at = value.range.last + 1
        }
        return out.append(text, at, text.length).toString()
    }

    /** Text with every secret removed: the known values first (every form, longest first), then the rules. */
    fun redact(text: String, secrets: List<String> = emptyList()): String {
        var out = text
        val known = secrets.filter { it.length >= 4 }.flatMap(::forms).filter { it.length >= 4 }.distinct().sortedByDescending { it.length }
        for (secret in known) out = out.replace(secret, "[redacted]", ignoreCase = true)
        for ((pattern, replace) in NAMED) out = pattern.replace(out, replace)
        out = keyValues(out)
        for ((pattern, replace) in SHAPES) out = pattern.replace(out, replace)
        return out
    }
}
