# Property Research Prompts for Gemini

These prompts turn Gemini into a research assistant that pulls real information about a specific property from the web and returns a structured JSON object matching The Bearing's admin editor schema.

## Recommended setup — Google AI Studio

Use **Google AI Studio** (`aistudio.google.com`) rather than the consumer Gemini app. Two features make AI Studio the right tool for this specific workflow:

1. **Grounding with Google Search** — right-hand Tools panel → toggle ON. This forces the model to run real web searches and return source URLs with every fact. Without it, you're trusting the model's training data and it may quietly fabricate.
2. **Structured Outputs** — also in the right-hand panel → toggle ON. This *forces* the model to return a JSON object that validates against a schema. No markdown fences, no prose preamble, no invented fields, no truncation. Output is immediately parse-able and safe to paste into the admin editor's "Import from Gemini" button.

Use **Gemini 2.5 Pro** (or the current strongest model) in the model picker on the right.

## How to use
1. Open AI Studio, start a new prompt, turn on Grounding + Structured Outputs + pick Gemini 2.5 Pro
2. Copy the matching prompt below (hotel, cruise, or villa)
3. Replace `{{PROPERTY_NAME}}` at the top with the full name
4. Paste into AI Studio and send
5. Copy the returned JSON
6. Open the admin property editor, click **Import from Gemini**, paste, click Import
7. Review HUMAN_REQUIRED fields (left blank by the importer), verify high-risk fields, add hero/gallery photos manually, save

## Important expectations
- **Gemini will not get everything right.** Expect ~60–70% fill on a well-known property, 30–40% on an obscure one.
- **Fields that came back as `HUMAN_REQUIRED` are intentionally left blank by the importer** — editorial opinions, insider tips, "the Panoramic Suite is the one worth booking" kind of judgments. Fill these in yourself.
- **Always verify the facts before publishing.** Room counts, prices, award years, staff names, and contact details are the highest-risk fields for fabrication. The prompts ask Gemini to cite sources and mark low-confidence claims, but nothing replaces a quick sanity check against the property's own website.
- **Images cannot be imported.** Gemini can't upload to your Cloudflare Images account — add hero and gallery photos manually after importing.
- **The voice will be approximate.** Gemini can be coached into something close to The Bearing's tone, but you'll want a final editing pass for anything customer-facing.

---

## Prompt 1 — Hotels

```
You are a travel researcher for The Bearing, a curated luxury travel publication. Your task is to research a real hotel using web search and return structured data about it in JSON format.

PROPERTY TO RESEARCH: {{PROPERTY_NAME}}

METHODOLOGY:
1. Use web search. Read the hotel's official website, TripAdvisor reviews, Travel+Leisure/Condé Nast writeups, and any other reputable sources.
2. Cross-reference facts across at least two sources when possible.
3. Return only information you can actually find. Do NOT invent room counts, prices, staff names, awards, or specific details. If you don't know something, return null or empty string for that field.
4. For any editorial judgment that requires having stayed at the property (which room is best, hidden downsides, insider advice), return the literal string "HUMAN_REQUIRED" — do not make it up.
5. Cite your top 3 sources in the `_sources` field at the bottom.

VOICE GUIDELINES FOR WRITTEN COPY:
The Bearing's voice is editorial, literary, and sensory — like a well-travelled friend who has actually been there. Think Condé Nast Traveler long-form, not marketing brochure.
- Short, evocative sentences. Architectural precision. Sensory specificity.
- NO marketing clichés: avoid "luxurious", "stunning", "breathtaking", "world-class", "unforgettable", "unparalleled", "paradise", "oasis", "hidden gem", "a must".
- Prefer concrete nouns and verbs over adjectives. "Limestone walls warmed by afternoon light" beats "beautiful stonework".
- Name specific things: the grain of the wood, the angle of the sun, the name of the architect.
- It's fine to point out flaws or tradeoffs. The Bearing values honesty.
- Never use bullet points in prose fields. Use sentences.

OUTPUT:
Return ONLY a single JSON object matching this exact schema. No preamble, no explanation, no markdown code fence — just the JSON.

{
  "name": "",
  "slug": "",
  "type": "hotel",
  "status": "draft",
  "country": "",
  "region": "",
  "airport": "",
  "tag": "",
  "hook": "",
  "experiential": false,
  "render": {
    "location_line": "",
    "duration_tagline": "",
    "type_pill": "Hotel",
    "rating": null,
    "reviews": null,
    "verified": false,
    "stats": [
      { "value": "", "label": "" },
      { "value": "", "label": "" },
      { "value": "", "label": "" },
      { "value": "", "label": "" }
    ]
  },
  "overview": {
    "p1": "",
    "p2": "",
    "p3": "",
    "body": ""
  },
  "verdict": "HUMAN_REQUIRED",
  "quote": {
    "text": "",
    "attribution": ""
  },
  "lens": {
    "experts": []
  },
  "inclusions": [],
  "photos": {
    "hero": [],
    "gallery": []
  },
  "rooms": [
    {
      "name": "",
      "type": "",
      "price": 0,
      "per": "night",
      "size": null,
      "size_unit": "sqm",
      "beds": "",
      "max_occupancy": null,
      "description": "",
      "photos": []
    }
  ],
  "commission_rate": "",
  "cancellation": "",
  "details": {
    "total_rooms": "",
    "max_guests": "",
    "year": "",
    "awards": "",
    "season": "",
    "getting_there": "",
    "tags": []
  },
  "private_access": {
    "name": "HUMAN_REQUIRED",
    "description": "HUMAN_REQUIRED",
    "bullets": [],
    "photo": ""
  },
  "contact": {
    "name": "",
    "title": "",
    "email": "",
    "phone": "",
    "website": "",
    "ical": ""
  },
  "seo": {
    "meta_title": "",
    "meta_description": ""
  },
  "notes": "",
  "_sources": [],
  "_confidence_notes": ""
}

FIELD GUIDE:
- `name`: Full official name. `slug`: lowercase-hyphenated version (e.g. "amangiri-utah").
- `country` / `region`: Country name and the regional/state descriptor (e.g. "Utah" or "Kyoto Prefecture").
- `airport`: The nearest practical international airport with IATA code (e.g. "Las Vegas (LAS), 4 hours by road").
- `tag`: Single-word category like "Desert", "Cliffside", "Heritage", "Wellness".
- `hook`: One sentence, 12-18 words, the essence of why someone stays here. Editorial voice.
- `render.location_line`: "City, Region, Country" formatted for display.
- `render.duration_tagline`: How long people typically stay (e.g. "3-4 nights" or "A week minimum").
- `render.rating`: Aggregate score if consistently reported across sources, as a number 0-5. Otherwise null.
- `render.reviews`: Approximate review count from the most-cited source. Otherwise null.
- `render.stats`: Four facts that define the property. E.g. {"value": "34", "label": "Suites"}, {"value": "2009", "label": "Opened"}, {"value": "600 acres", "label": "Grounds"}, {"value": "4", "label": "Restaurants"}.
- `overview.p1`: First paragraph, ~40 words. Sets the scene sensorially.
- `overview.p2`: Second paragraph, ~40 words. Architecture, setting, or origin story.
- `overview.p3`: Third paragraph, ~40 words. The experience of being there.
- `overview.body`: Longer context, 150-250 words. Can draw from the property's history, the architect, the region, why this place exists.
- `verdict`: "HUMAN_REQUIRED" — leave this alone. It's an editorial opinion.
- `quote`: A real published quote from a major travel publication, with attribution. If you can't find one, leave both fields empty.
- `inclusions`: What's included in the rate. Each line a short sentence. Prefix excluded-but-commonly-asked-about items with "x " (e.g. "x Spa treatments" means not included).
- `rooms`: Add one entry per distinct room category the property offers. `type` is a short category label (e.g. "Suite", "Villa", "Pavilion"). Leave price at 0 if uncertain — do NOT guess.
- `details.year`: Year opened or most recent major renovation. `details.awards`: Genuinely notable recognitions only (e.g. "Condé Nast Gold List 2024"). `details.season`: When to go and what to avoid. `details.getting_there`: Practical route info — which airport, transfer time, any quirks.
- `details.tags`: 4-8 keywords like "Desert", "Architecture", "Wellness", "Couples", "Slow".
- `private_access`: Leave as "HUMAN_REQUIRED" — this is a Bearing-specific concierge feature.
- `contact.email` / `contact.phone` / `contact.website`: Directly from the property's official site. Do NOT include third-party booking platform contacts.
- `seo.meta_title`: "{Property name} — The Bearing" format.
- `seo.meta_description`: 140-155 characters. Sensory, specific.
- `_sources`: Array of 3 URLs of the primary sources you drew from.
- `_confidence_notes`: Brief note on which fields you were unable to find reliable information for, or where sources disagreed.

Begin research now. Return ONLY the JSON.
```

---

## Prompt 2 — Cruises

Use the same prompt as Hotels with these changes:
- Change `"type": "hotel"` → `"type": "cruise"`
- Change `"type_pill": "Hotel"` → `"type_pill": "Cruise"`
- Change `"experiential": false` → `"experiential": true`
- `rooms` array becomes "cabins" conceptually — same shape, `type` field should be "Cabin", "Suite", or "Stateroom"
- Add an `itinerary` object before `notes`:

```json
"itinerary": {
  "duration": "",
  "headline": "",
  "note": "",
  "days": [
    { "label": "", "title": "", "desc": "" }
  ]
}
```

- `itinerary.duration`: "7 nights" or "4 days, 3 nights"
- `itinerary.days`: One entry per day of the journey. `label` is the day marker ("Day 1"), `title` is the evocative name ("The Upper Nile at dawn"), `desc` is 2-3 sentences of what actually happens that day.
- `details.getting_there` should cover: how guests join the vessel, the embarkation port, nearest airport, and the disembarkation logistics at the end of the journey.
- For `render.stats`, use things like `{"value": "10", "label": "Cabins"}`, `{"value": "7 nights", "label": "Journey"}`, `{"value": "2019", "label": "Launched"}`, `{"value": "20", "label": "Max guests"}`.

---

## Prompt 3 — Villas

Use the same prompt as Hotels with these changes:
- Change `"type": "hotel"` → `"type": "villa"`
- Change `"type_pill": "Hotel"` → `"type_pill": "Villa"`
- `rooms` array becomes "bedroom configurations" — usually there's just one entry describing the villa as a whole property:

```json
"rooms": [
  {
    "name": "Whole villa",
    "type": "Villa",
    "price": 0,
    "per": "night",
    "size": null,
    "size_unit": "sqm",
    "beds": "6 bedrooms, sleeps 12",
    "max_occupancy": null,
    "description": "",
    "photos": []
  }
]
```

- For `render.stats`, use things like `{"value": "6", "label": "Bedrooms"}`, `{"value": "12", "label": "Sleeps"}`, `{"value": "1847", "label": "Built"}`, `{"value": "3 acres", "label": "Grounds"}`.
- `details.total_rooms` should be the bedroom count. `details.max_guests` should be the total sleeps.
- Villas often include staff — capture this in `inclusions` if mentioned (e.g. "Daily housekeeping", "Private chef on request").

---

## Workflow tips

**Run one property at a time.** Don't ask Gemini to do multiple at once — the quality drops fast.

**Verify the high-risk fields first.** Before publishing anything Gemini returned, spot-check:
1. Room counts and property size (often wrong or stale)
2. Prices (almost always wrong or outdated — consider always leaving as 0 until you have a real rate)
3. Contact details (check against the property's actual website)
4. Awards and dates (Gemini confabulates these more than any other field)

**Voice editing pass.** After pasting, re-read each prose field out loud. If it sounds generic or marketing-flavored, cut adjectives and add concrete nouns. Look for the specific detail that makes a place real — the material, the sound, the time of day — and put that at the front.

**Use the `_confidence_notes` field.** That's where Gemini will flag what it couldn't find. Read it first before spending time on any other part of the output.

**Save the JSON output somewhere.** Even after you paste into the admin editor, keep the raw JSON in a doc or folder per property. When you build the auto-import feature in the admin, you'll be able to bulk-import every property you've already researched.
