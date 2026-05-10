import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const config = {
  maxDuration: 300,
  api: { bodyParser: { sizeLimit: '20mb' } }
};

const IDENTIFY_PROMPT = `You are analyzing employee benefits documents. List every distinct benefit type covered in these documents.
Return ONLY valid JSON: { "benefits": ["Benefit Name 1", "Benefit Name 2", ...] }
Be specific with names (e.g. "Private Medical Insurance", "Group Life Assurance", "Bikes for Work").
Do not group — list each benefit separately. If you see a section header for a benefit, include it.`;

const extractPrompt = (benefitName) => `You are an expert at reading employee benefits documents and extracting configuration data.

Extract configuration for "${benefitName}" ONLY from the document(s) provided. Ignore all other benefits.

Return ONLY valid JSON in this exact format:
{
  "benefit_name": "${benefitName}",
  "benefit_type": "string (category, e.g. Insurance, Salary Sacrifice, etc.)",
  "employer": "string (company name if found, else null)",
  "currency": "GBP",
  "questions": [
    {
      "id": "snake_case_unique_id",
      "question_text": "Field label",
      "section": "Section name",
      "extracted_answer": "value or null",
      "extracted_confidence": "high|medium|low",
      "source": "brief quote from document",
      "conflict": false,
      "conflict_options": []
    }
  ],
  "conflicts": [],
  "missing": []
}

Extract all relevant fields including: coverage levels, limits, premiums, contributions, eligibility criteria, waiting periods, exclusions, renewal date, insurer/provider name, policy number, employee contributions, employer contributions, dependant coverage, tax treatment, salary sacrifice details, and any other plan-specific configuration.`;

function cleanJson(str) {
  return str.replace(/,\s*([}\]])/g, '$1');
}

function buildContentBlocks(files) {
  const blocks = [];
  for (const file of files) {
    const { name, type, data, base64 } = file;
    const raw = data || base64;
    if (!raw) continue;
    const base64Data = raw.includes(',') ? raw.split(',')[1] : raw;
    if (type === 'application/pdf' || name?.toLowerCase().endsWith('.pdf')) {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data }, title: name || 'document.pdf' });
    } else if (type?.startsWith('image/')) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: type, data: base64Data } });
    } else {
      let text;
      try { text = Buffer.from(base64Data, 'base64').toString('utf-8'); } catch { text = base64Data; }
      blocks.push({ type: 'text', text: `--- Document: ${name || 'file'} ---\n${text}` });
    }
  }
  return blocks;
}

const mapBenefit = (b) => {
  const name = b.benefit_name || 'Unknown Benefit';
  const questions = (b.questions || []).map((q, i) => ({
    id: q.id || ('q_' + i),
    question_text: q.question_text || q.question || '',
    section: q.section || 'Configuration',
    extracted_answer: q.extracted_answer ?? q.extracted ?? q.answer ?? null,
    extracted_confidence: q.extracted_confidence || q.confidence || 'medium',
    source: q.source || null,
    conflict: q.conflict || false,
    conflict_options: q.conflict_options || []
  }));
  return {
    shell: {
      benefit_name: name,
      benefit_type: b.benefit_type || name,
      benefit_id_external: null,
      employer: b.employer || null,
      currency: b.currency || 'GBP'
    },
    questions,
    question_count: questions.length,
    conflicts: b.conflicts || [],
    missing: b.missing || []
  };
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { files } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const contentBlocks = buildContentBlocks(files);
    if (contentBlocks.length === 0) return res.status(400).json({ error: 'No readable content found in files' });

    // Pass 1: identify all benefit types
    const identifyMsg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: IDENTIFY_PROMPT,
      messages: [{
        role: 'user',
        content: [...contentBlocks, { type: 'text', text: 'List all distinct benefit types covered in these documents.' }]
      }]
    });

    let benefitNames = [];
    try {
      const raw = identifyMsg.content[0]?.text || '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(cleanJson(jsonMatch[0]));
        benefitNames = Array.isArray(parsed.benefits) ? parsed.benefits : [];
      }
    } catch (e) {
      console.error('Failed to parse benefit list:', e);
    }

    if (benefitNames.length === 0) {
      return res.status(200).json({ benefits: [], error: 'Could not identify any benefit types in the documents.' });
    }

    // Pass 2: extract each benefit in parallel
    const results = await Promise.all(benefitNames.map(async (name) => {
      try {
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 4096,
          system: extractPrompt(name),
          messages: [{
            role: 'user',
            content: [...contentBlocks, { type: 'text', text: `Extract the full configuration for "${name}" only.` }]
          }]
        });
        const raw = msg.content[0]?.text || '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        const parsed = JSON.parse(cleanJson(jsonMatch[0]));
        return mapBenefit(parsed);
      } catch (e) {
        console.error(`Error extracting "${name}":`, e.message);
        return null;
      }
    }));

    const benefits = results.filter(Boolean);
    return res.status(200).json({ benefits });

  } catch (err) {
    console.error('Extract error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error', type: err.constructor?.name });
  }
}
