package com.scantomake.counterpart.api

import com.scantomake.counterpart.core.WireJson
import com.scantomake.counterpart.core.jsonOf
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement

/**
 * Add printer (PRD §5.8, §6.1): what the companion's `printers.discover`, `.check`, `.obtain` and `.add` answer over
 * `/v1/printers/setup/` (objects-api.md), the same calls the Mac and Linux make. Port of CounterpartKit
 * `PrinterSetup.swift`. Every brand, field, label and hint is the printer MCPs' own (`counterpart_setup_fields`).
 */
@Serializable
data class PrinterSetupOptions(val types: List<PrinterType> = emptyList(), val models: Map<String, List<Choice>> = emptyMap(),
                               val serialModels: Map<String, String>? = null, val slicer: Map<String, Slicer>? = null,
                               val updates: List<Update>? = null) {
    @Serializable data class Choice(val value: String, val label: String)
    @Serializable data class Obtain(val label: String, val hint: String? = null, val backends: List<String> = emptyList())
    @Serializable data class Secret(val label: String, val hint: String? = null, val required: Boolean = false, val obtain: Obtain? = null)
    /** One of the MCP's own settings: its `.env` variable, label, hint, whether it's needed, and how it's typed ("path", "url"). */
    @Serializable data class Field(val name: String, val env: String, val label: String, val hint: String? = null, val required: Boolean = false,
                                   val input: String? = null, val choices: List<Choice>? = null)
    @Serializable data class Slicer(val type: String, val path: String? = null, val found: Boolean = false, val profilesRoot: String? = null,
                                    val profilesFound: Boolean? = null, val fields: List<Field> = emptyList()) {
        fun field(name: String) = fields.firstOrNull { it.name == name }
    }
    @Serializable data class Update(val `package`: String, val message: String)
    /** A brand or host software, and the MCPs that can reach it (the default first). */
    /** The address field in the MCP's words; `url` when it also takes a web address (https://…, a sub-path; #389). */
    @Serializable data class Address(val hint: String? = null, val url: Boolean? = null)
    @Serializable data class PrinterType(val printerType: String, val label: String, val backends: List<String> = emptyList(),
                                         val serial: Boolean = false, val secret: Secret? = null, val address: Address? = null,
                                         val fields: List<Field>? = null) {
        fun field(name: String) = fields?.firstOrNull { it.name == name }
    }
    /** The model a typed serial number names, by the MCP's own table (its prefixes are all one length). */
    fun model(serial: String): String? {
        val length = serialModels?.keys?.firstOrNull()?.length ?: return null
        val prefix = serial.trim().take(length).uppercase()
        return if (prefix.length == length) serialModels[prefix] else null
    }
    fun type(printerType: String) = types.firstOrNull { it.printerType == printerType }
}

/** A printer the MCPs found: a configured MCP folder on the computer, or a printer on its network. Never a secret. */
@Serializable
data class PrinterCandidate(val id: String, val source: String, val name: String, val backend: String, val printerType: String,
                            val model: String? = null, val host: String? = null, val port: String? = null, val serial: String? = null,
                            val folder: String? = null, val added: Boolean = false, val missing: List<String>? = null,
                            val fill: Map<String, String>? = null) {
    /** The `.env` variable its MCP declares for the printer's model (`counterpart_setup_fields`), never a name the app knows. */
    fun modelSetting(options: PrinterSetupOptions?): String? = options?.type(printerType)?.field("model")?.env
    /** Its MCP needs a model Counterpart couldn't tell, by the MCP's own model field: the phone asks. */
    fun needsModel(options: PrinterSetupOptions?): Boolean = modelSetting(options)?.let { missing?.contains(it) == true && fill?.get(it) == null } ?: false
    /** The model Add fills for it, when Counterpart could tell. */
    fun filledModel(options: PrinterSetupOptions?): String? = modelSetting(options)?.let { fill?.get(it) }
}

@Serializable data class PrinterDiscovery(val found: List<PrinterCandidate> = emptyList(), val network: String = "complete", val options: PrinterSetupOptions = PrinterSetupOptions(),
                                         /** Each MCP's name as people see it, from the companion. */
                                         val labels: Map<String, String>? = null) {
    /** An MCP's name: the companion's, else its package name as it is. Never mapped here. */
    fun label(backend: String): String = labels?.get(backend) ?: backend
}
@Serializable data class PrinterCheckResult(val reached: Boolean, val camera: String = "not-supported", val image: Image? = null, val model: String? = null) {
    @Serializable data class Image(val mimeType: String, val base64: String)
}
@Serializable data class PrinterAdded(val id: String, val destinationId: String? = null, val sameAs: String? = null)
/** One step of `printers.obtain`: what the person sees, the page where they approve it, and once approved the value. */
@Serializable data class ObtainStep(val session: String? = null, val status: String, val message: String, val approveUrl: String? = null, val value: String? = null) {
    val pending: Boolean get() = status == "pending"
    val approvalPage: String? get() = approveUrl?.takeIf { it.startsWith("http://", true) || it.startsWith("https://", true) }
}

/** What Check and Add send: a found folder, or the form's fields (`PrinterFormSchema`). `secret` is the access code or API key. */
data class PrinterForm(val folder: String? = null, val backend: String = "bambu-printer-mcp", val printerType: String = "bambu",
                       val host: String = "", val port: String? = null, val serial: String = "", val model: String? = null,
                       val secret: String = "", val name: String? = null, val slicer: String? = null, val slicerPath: String? = null,
                       val profiles: String? = null,
                       /** The model came from discovery or the serial number, not the person: a changed serial picks it again. Not sent. */
                       val modelInferred: Boolean = false) {
    /** The same wire form as CounterpartKit's `PrinterForm` encoding. */
    fun json(): JsonObject {
        if (folder != null) return jsonOf("folder" to folder, "model" to model)
        val fields = linkedMapOf<String, JsonPrimitive>("backend" to JsonPrimitive(backend), "printerType" to JsonPrimitive(printerType), "host" to JsonPrimitive(host.trim()))
        if (!port.isNullOrEmpty()) fields["port"] = JsonPrimitive(port)
        if (printerType == "bambu") {
            fields["serial"] = JsonPrimitive(serial.trim())
            model?.let { fields["model"] = JsonPrimitive(it) }
        }
        if (secret.isNotEmpty()) fields["secret"] = JsonPrimitive(secret)
        if (!name.isNullOrEmpty()) fields["name"] = JsonPrimitive(name)
        if (!slicer.isNullOrEmpty()) fields["slicer"] = JsonPrimitive(slicer)
        if (!slicerPath.isNullOrEmpty()) fields["slicerPath"] = JsonPrimitive(slicerPath)
        if (!profiles.isNullOrEmpty()) fields["profiles"] = JsonPrimitive(profiles)
        return JsonObject(fields)
    }
}

suspend fun CompanionClient.discoverPrinters(): PrinterDiscovery =
    WireJson.decodeFromJsonElement(request("POST", "/v1/printers/setup/discover", JsonObject(emptyMap()), timeoutMs = 25_000))

suspend fun CompanionClient.checkPrinter(form: PrinterForm): PrinterCheckResult =
    request("POST", "/v1/printers/setup/check", jsonOf("printer" to form.json()), timeoutMs = 70_000).opt("check")
        ?: throw CompanionException("invalid-response", "Your computer sent something this app doesn't understand. Update both apps.")

suspend fun CompanionClient.addPrinter(form: PrinterForm): PrinterAdded =
    WireJson.decodeFromJsonElement(request("POST", "/v1/printers/setup/add", jsonOf("printer" to form.json()), timeoutMs = 40_000))

/** One `printers.obtain` step: starts without `session`; with it, waits about 20 s for the person's answer. */
suspend fun CompanionClient.obtainSetupValue(form: PrinterForm, field: String, session: String? = null): ObtainStep =
    WireJson.decodeFromJsonElement(request("POST", "/v1/printers/setup/obtain", jsonOf("backend" to form.backend, "printerType" to form.printerType,
        "host" to form.host.trim(), "port" to form.port?.takeIf { it.isNotEmpty() }, "field" to field, "session" to session), timeoutMs = 70_000))

/** Runs `printers.obtain` until the person answers in the MCP's page, it fails, or the caller is cancelled. */
suspend fun CompanionClient.obtainUntilAnswered(form: PrinterForm, field: String, shown: (ObtainStep) -> Unit): ObtainStep {
    var current = obtainSetupValue(form, field)
    shown(current)
    while (current.pending && current.session != null && currentCoroutineContext().isActive) {
        current = obtainSetupValue(form, field, current.session)
        shown(current)
    }
    return current
}

/** The serial names the model (the MCP's own table), unless the person chose one: a corrected serial picks again. */
fun PrinterForm.withSerial(value: String, options: PrinterSetupOptions): PrinterForm {
    if (model != null && !modelInferred) return copy(serial = value)
    val named = options.model(value)?.takeIf { m -> options.models[backend].orEmpty().any { it.value == m } }
    return copy(serial = value, model = named ?: if (modelInferred) null else model, modelInferred = named != null)
}

/** The address field: the MCP's hint, and a prompt that offers a web address only where the MCP takes one. Port of CounterpartKit `AddressField`. */
data class AddressField(val hint: String?, val prompt: String, val url: Boolean)
fun addressField(options: PrinterSetupOptions?, printerType: String): AddressField {
    val address = options?.type(printerType)?.address
    val url = address?.url == true
    return AddressField(address?.hint, if (url) "192.168.1.20, printer.local or https://…" else "192.168.1.20 or printer.local", url)
}

/** The key or access code the chosen MCP can fetch for the person (`obtain`): its button's words, or null. */
fun obtainControl(options: PrinterSetupOptions?, form: PrinterForm): PrinterSetupOptions.Obtain? =
    options?.type(form.printerType)?.secret?.obtain?.takeIf { form.folder == null && form.backend in it.backends }
