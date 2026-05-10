import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const config = {
  maxDuration: 300,
  api: { bodyParser: { sizeLimit: '20mb' } }
};

const SYSTEM_PROMPT = `You are an expert at reading employee benefits documents and extracting configuration data.

You will be given one or more benefit documents. Return ONLY valid JSON:
{
  "benefit_name": "e.g. Private Medical Insurance",
  "employer": "company name or null",
  "questions": [
    {
      "id": "unique_snake_case_id",
      "question": "Field name / question",
      "extracted": "extracted value or null",
      "confidence": "high|medium|low",
      "source": "brief quote or page reference"
    }
  ],
  "conflicts": [],
  "missing": []
}

Extract every configuration field you can find: insurer name, policy number, coverage levels, limits, premiums, employee contributions, employer contributions, eligibility criteria, waiting periods, exclusions, renewal date, dependant coverage, and any other plan-specific fields.`;
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { files } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const contentBlocks = [];
    for (const file of files) {
      const { name, type, base64 } = file;
      if (!base64) continue;
      const b64Data = base64.includes(',') ? base64.split(',')[1] : base64;
      if (type === 'application/pdf' || name?.toLowerCase().endsWith('.pdf')) {
        contentBlocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64Data }, title: name || 'document.pdf' });
      } else if (type?.startsWith('image/')) {
        contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: type, data: b64Data } });
      } else {
        let text;
        try { text = Buffer.from(b64Data, 'base64').toString('utf-8'); } catch { text = b64Data; }
        contentBlocks.push({ type: 'text', text: `--- Document: ${name || 'file'} ---\n${text}` });
      }
    }
    if (contentBlocks.length === 0) {
      return res.status(400).json({ error: 'No readable content found in files' });
    }
    contentBlocks.push({ type: 'text', text: 'Extract the benefit configuration and return the JSON as specified.' });
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: contentBlocks }]
    });

    const responseText = message.content[0]?.text || '';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'Model did not return valid JSON', raw: responseText.slice(0, 500) });
    }

    const raw = JSON.parse(jsonMatch[0]);

    // Shape response to match frontend expectations
    const result = {
      shell: {
        benefit_name: raw.benefit_name || raw.benefitType || 'Unknown Benefit',
        employer: raw.employer || null
      },
      questions: (raw.questions || raw.answers || []).map((q, i) => ({
        id: q.id || `q_${i}`,
        question: q.question,
        extracted: q.extracted ?? q.answer ?? null,
        confidence: q.confidence || 'medium',
        source: q.source || null
      })),
      conflicts: raw.conflicts || [],
      missing: raw.missing || raw.missingInfo || []
    };

    return res.status(200).json(result);

  } catch (err) {
    console.error('Extract error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error', type: err.constructor?.name });
  }
}
