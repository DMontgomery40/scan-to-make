# Messaging: how Counterpart explains itself

David, 2026-11-05, about counterpart.dtmont.com: "pretend you never heard of this. then you see 'pair once'… okay?? what?? pair what? what does this place do." And: "you overcorrect and then underexplain and then over explain."

This brief is the fix. Every surface — the site, Help, and the apps' first-run screens — explains the same concepts in the same order, each once, at the moment the reader needs it.

## The one-sentence answer

**Counterpart turns a scan, a description, or a link into the part you need, printed on your 3D printer — designed or cleaned up on your computer, checked by you before it prints.**

The headline form is "Make the part that fits."

## Who it's for

Someone with a 3D printer (or a printer on the way) who needs a specific part: a replacement knob, a mount for the mic they own, a hook that fits their desk edge, a filler for an 8 mm gap. They are not CAD users and don't want to become one. They have a phone and a Mac or Linux PC. They may also find models other people published and want them printed as designed, or changed a little.

They arrive knowing none of our words. Assume they know what a 3D printer is and nothing else.

## The concepts, in order

A newcomer needs four things, in this order. Each is explained once, in full, where its row says, and only referred to briefly anywhere else. Nothing later in the list may appear before the things before it make sense.

| # | Concept | The sentence that carries it | Where it's explained in full |
|---|---|---|---|
| 1 | **You need a part.** Counterpart is for the moment something is missing, broken, or doesn't fit. | "Make the part that fits." (Examples: a hook that fits my desk edge, a filler for this 8 mm gap.) | The hero headline and lede; the first screen of each app. |
| 2 | **Three ways to start:** scan the object with your phone, describe the part in your own words, or paste a link to a published model. | "Scan it. Describe it. Paste a link." | The hero lede (one sentence), then the "Three ways to start" section (one card each). In the apps, the New sheet is the same three. |
| 3 | **You check it, then it prints.** Counterpart designs the part or cleans up your scan, shows you exactly what will print, and prints it on your printer. You can ask for changes in plain words. | "See exactly what will print before it starts." | "How it works" (the steps from request to print) and "What will print". Everything before this is need and input; this is where AI, cleanup and the printer first appear. |
| 4 | **What you need:** a computer, a phone if you want to scan, and a printer. | "Your computer makes it. Your phone goes where the object is. Your printer prints it." | One section ("What you need"), after the reader knows what Counterpart does. Privacy repeats the one fact that matters there (your scans and projects stay on your computer). Nowhere else. |

### Where "it runs on your own computer" lives

It is a supporting fact inside concepts 3 and 4, never the headline:

- In "How it works" it appears because that's where the making happens: "Your computer makes it."
- In "What you need" it is explained once, fully: which computer (a Mac or a Linux PC), that your phone connects to it, and that connecting is automatic with the same Apple Account or a code you scan once.
- In Privacy, once: your scans, photos and projects stay on your computer; there is no Counterpart account.

It never appears in the headline, the hero lede, the footer, or as a repeated refrain. A reader who reaches Download must know they need a computer; a reader at the top must first know what Counterpart makes.

### Where printers and printer software live

Inside concept 4, once: Counterpart works with Bambu Lab, Prusa, Klipper, OctoPrint and others, through free printer software you install from Settings › Printers. The two programs are named there, and in Help and Credits — the places a person setting up a printer is reading. They are not named in the hero, and "MCP" is never used.

## The words

| We say | We never say | Why |
|---|---|---|
| connect, connection, connected | pair, pairing, paired | "Pair" names a mechanism, not a purpose. A phone connects to a computer so the computer can make the part and run the printer; say that. (Code identifiers keep their names.) |
| your computer (or "your Mac" where only a Mac fits) | companion, host, bridge, server | The thing on their desk. |
| runs on your Mac or Linux PC | self-hosted | "Self-hosted" is a deployment claim, not an explanation. If a technical page must use it, the sentence before it explains it. |
| printer software | MCP, MCP server | An internal protocol name. The programs themselves are named where a person installs them. |
| what will print | the sliced file / the slice, before it's explained | "Sliced" is fine after one plain gloss ("prepared for your printer, layer by layer — sliced"). Before that, say "what will print". |
| loaded spools, colours | AMS (first mention) | Name Bambu's AMS only after "the colours loaded in the printer" is understood. |
| scan, describe, paste a link | capture, input, job (for the person's request) | Their verbs. |
| project | job, pass | What the apps show. |

Rules for every surface:

1. **Answer the need before the mechanism.** If a sentence explains how something connects, the reader must already know what it's for.
2. **Explain each concept once, in its place.** Later references are short ("your computer", "what will print"), never a second full explanation. The same fact stated in the hero, the steps, the platforms section, Privacy and the footer is over-explaining.
3. **No concept before its turn.** Connecting a phone is never mentioned before the computer's job is understood. Printer software is never named before printers. Nothing is "just" or "simply" anything.
4. **Concrete over general.** "A hook that fits my desk edge" beats "custom parts". Millimetres beat "accurate".
5. **No dev, prompt or meta text.** Nothing about how the page, the illustrations or the product was made; no disclaimers; no tool names; nothing in the voice of the team ("we did not invent…").
6. **Short.** If a section needs a second paragraph to be understood, the first one is wrong.

## The home page, mapped to the concepts

| Order | Section | Concept | Space |
|---|---|---|---|
| 1 | Hero: headline, lede, Download | 1 and 2 (the need; the three ways in one sentence) | Headline + two sentences |
| 2 | Three ways to start | 2 | Three cards, two short paragraphs each |
| 3 | How it works | 3 | Six one-line steps, request → printed part |
| 4 | What will print | 3 | Pictures of the exact print, three one-line facts |
| 5 | What people make with Counterpart | 1 (proof, after the reader knows how) | Request quotes under each part |
| 6 | What you need (platform tabs + checklist) | 4 | Two sentences + one panel per platform |
| 7 | Printers | 4 | One paragraph; the two programs named here |
| 8 | Connect your phone | 4 | One sentence of why, then the three ways to connect |
| 9 | Privacy | 4 (the one repeat) | Four one-line facts |
| 10 | Quick answers | Leftovers | Five questions, linking to Help |
| 11 | Start with these | Start | The two starter projects |
| 12 | Download | Start | One card per platform, last thing on the page |

Help follows the same order (set up → connect a phone → start a project → …) and opens with the one-sentence answer. The setup page (beta) is concept 4 and Start only.

## The apps' first screens, mapped

- **Welcome (iPhone, Android):** concepts 1–2, then one sentence of concept 4 as a preview of the next step: your computer does the making and printing, so the next step connects this phone to it. Without that sentence, the next screen's camera and code arrive unexplained — the "pair what?" failure in the app.
- **Connect screen (Find your Mac / Find your computer):** its first sentence says what the computer is for. Buttons say **Connect**, never "Pair".
- **Mac first window:** the code and nothing else (David's hard requirement, journey.md §3.4). It carries no explanation because the phone in the person's other hand carries it. Its accessible label says what the code is for.
