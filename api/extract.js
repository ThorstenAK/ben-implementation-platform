import { neon } from '@neondatabase/serverless';
import Anthropic from '@anthropic-ai/sdk';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const sql = neon(process.env.POSTGRES_URL);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const config = {
  maxDuration: 300,
  api: { bodyParser: { sizeLimit: '20mb' } }
};

async function extractText(filename, base64content, filetype) {
  const buffer = Buffer.from(base64content, 'base64');

  if (filetype === 'application/pdf' || filename.endsWith('.pdf')) {
    try {
      const data = await pdfParse(buffer);
      return { text: data.text, page_count: data.numpages };
    } catch (err) {
      console.error('PDF parse error for', filename, err.message);
      return { text: '', page_count: 0 };
    }
  }

  return { text: buffer.toString('utf-8'), page_count: 1 };
}

const EXTRACTION_PROMPT = `You are an implementation analyst for Ben, an employee benefits platform.

You have been given one or more documents relating to a specific employee benefit — this may include a requirements document, a step-by-step build guide, an allowance policy, a payroll template, or a provider policy document.

Your task:
1. Identify the benefit type and name
2. Generate ALL configuration questions an implementation manager must answer to correctly build this benefit on the Ben platform
3. Pre-fill answers where you can find them in the documents

Return ONLY a valid JSON object — no markdown fences, no explanation, nothing outside the JSON.

Structure:
{
  "benefit_type": "warrants_flexible | pmi | cycle_to_work | dental | group_life | income_protection | allowance | payroll | other",
  "benefit_name": "exact employee-facing name",
  "benefit_id_external": "benefit ID if mentioned, else null",
  "currency": "GBP | EUR | USD",
  "questions": [
    {
      "key": "snake_case_unique_identifier",
      "text": "The question the implementation manager must answer",
      "section": "configuration | pricing | eligibility | enrolment | payroll | edge_cases",
      "answer": "extracted value as a string, or null if not found",
      "confidence": "high | medium | missing",
      "source_document": "filename or null",
      "source_page": 1,
      "source_quote": "verbatim quote under 20 words or null",
      "conflict": false,
      "conflict_options": null
    }
  ]
}

Rules:
- confidence "high": exact, unambiguous value found
- confidence "medium": value implied or partially specified
- confidence "missing": question is clearly relevant but no answer found in documents
- If the same configuration field has different values in different documents: set "conflict": true and "conflict_options": [{"value": "...", "source_document": "...", "source_page": 1}, ...]
- Copy numerical values exactly — never round, never approximate
- Generate questions for EVERY configurable aspect: display settings, pricing, eligibility rules, enrolment windows, UI labels, calculation factors, edge cases, error states, payroll codes
- Include platform-specific fields like slider static_max, enrolment window types, component counts
- Do NOT generate trivially universal questions (e.g. "should this benefit have a name")
- Sort questions within each section from most fundamental to most specific`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { implementation_id, files } = req.body;

  if (!implementation_id) return res.status(400).json({ error: 'implementation_id required' });
  if (!files?.length) return res.status(400).json({ error: 'At least one file required' });

  try {
    const docs = [];
    for (const file of files) {
      const { text, page_count } = await extractText(file.name, file.base64, file.type);
      if (!text.trim()) continue;

      const [doc] = await sql`
        INSERT INTO documents (implementation_id, filename, filetype, text_content, page_count)
        VALUES (${implementation_id}, ${file.name}, ${file.type}, ${text}, ${page_count})
        RETURNING id, filename
      `;
      docs.push({ id: doc.id, filename: file.name, text, page_count });
    }

    if (!docs.length) {
      return res.status(400).json({ error: 'Could not extract text from any uploaded file' });
    }

    const docBlock = docs.map(d =>
      `=== DOCUMENT: ${d.filename} (${d.page_count} pages) ===\n${d.text}`
    ).join('\n\n');

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: `${EXTRACTION_PROMPT}\n\nDOCUMENTS:\n\n${docBlock}`
        }
      ]
    });

    const raw = message.content[0].text.trim();
    const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    let extracted;
    try {
      extracted = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('Opus returned invalid JSON:', raw.slice(0, 500));
      return res.status(500).json({ error: 'Extraction returned invalid JSON', raw: raw.slice(0, 500) });
    }

    const [shell] = await sql`
      INSERT INTO benefit_shells (implementation_id, benefit_type, benefit_name, benefit_id_external, currency, status)
      VALUES (
        ${implementation_id},
        ${extracted.benefit_type || 'other'},
        ${extracted.benefit_name || 'Unknown benefit'},
        ${extracted.benefit_id_external || null},
        ${extracted.currency || 'GBP'},
        'review'
      )
      RETURNING *
    `;

    const questions = extracted.questions || [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      await sql`
        INSERT INTO questions (
          benefit_shell_id, question_key, question_text, section,
          extracted_answer, extracted_confidence,
          source_document, source_page, source_quote,
          conflict, conflict_options, sort_order
        ) VALUES (
          ${shell.id},
          ${q.key || `q_${i}`},
          ${q.text || ''},
          ${q.section || 'configuration'},
          ${q.answer || null},
          ${q.confidence || 'missing'},
          ${q.source_document || null},
          ${q.source_page || null},
          ${q.source_quote || null},
          ${q.conflict || false},
          ${q.conflict_options ? JSON.stringify(q.conflict_options) : null},
          ${i}
        )
      `;
    }

    const savedQuestions = await sql`
      SELECT * FROM questions
      WHERE benefit_shell_id = ${shell.id}
      ORDER BY sort_order ASC
    `;

    res.status(200).json({
      shell,
      questions: savedQuestions,
      doc_count: docs.length,
      question_count: savedQuestions.length
    });

  } catch (err) {
    console.error('Extract error:', err);
    res.status(500).json({ error: err.message });
  }
}
