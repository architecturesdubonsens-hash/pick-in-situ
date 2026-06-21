import { NextRequest, NextResponse } from "next/server";

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `Tu es un expert en analyse architecturale. Analyse cette photo de façade de bâtiment et extrait tous les éléments architecturaux visibles avec précision.

Retourne UNIQUEMENT du JSON valide dans ce format exact, sans texte ni balise :
{
  "facade": {
    "aspect_ratio": 2.0,
    "floors": 3,
    "style": "haussmannien",
    "notes": "description courte"
  },
  "elements": [
    {
      "type": "window",
      "label": "Fenêtre R+1 travée gauche",
      "x": 0.08,
      "y": 0.35,
      "width": 0.12,
      "height": 0.18
    }
  ]
}

Règles strictes :
- x, y, width, height sont des fractions [0-1] de la FAÇADE visible (pas de la photo entière)
- x=0 = bord gauche, x=1 = bord droit, y=0 = sommet, y=1 = bas
- type autorisés : window | door | garage | balcony | column | arch | cornice | pillar | chimney
- Liste CHAQUE élément séparément, même répété (ex: 6 fenêtres identiques = 6 entrées)
- aspect_ratio = largeur / hauteur
- Si mesure de référence fournie, utilise-la pour affiner les proportions
`;

export async function POST(req: NextRequest) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GOOGLE_API_KEY manquant dans .env.local" }, { status: 500 });
  }

  const body = await req.json();
  const { imageBase64, mimeType = "image/jpeg", measureNote } = body as {
    imageBase64: string;
    mimeType?: string;
    measureNote?: string;
  };

  if (!imageBase64) {
    return NextResponse.json({ error: "imageBase64 requis" }, { status: 400 });
  }

  const userText = measureNote
    ? `${SYSTEM_PROMPT}\n\nMesure de référence fournie par l'architecte : ${measureNote}`
    : SYSTEM_PROMPT;

  const geminiBody = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
        { text: userText },
      ],
    }],
    generationConfig: {
      response_mime_type: "application/json",
      temperature: 0.1,
      max_output_tokens: 4096,
    },
  };

  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(geminiBody),
  });

  if (!res.ok) {
    const err = await res.text();
    return NextResponse.json({ error: `Gemini API: ${res.status} — ${err}` }, { status: 502 });
  }

  const data = await res.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  try {
    const facadeData = JSON.parse(rawText);
    return NextResponse.json({ ok: true, data: facadeData, model: GEMINI_MODEL });
  } catch {
    return NextResponse.json({ error: "JSON invalide retourné par Gemini", raw: rawText }, { status: 502 });
  }
}
