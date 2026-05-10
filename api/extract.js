import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const config = {
  maxDuration: 300,
  api: { bodyParser: { sizeLimit: '20mb' } }
};

const SYSTEM_PROMPT = `You are an expert at reading employee benefits documents.

You will receive one or more benefit documents. Group them by benefit type — if documents relate to different benefits (e.g. PMI and Pension), return one object per benefit. If all documents relate to the same benefit, return one object.

Return ONLY valid JSON (no markdown, no trailing commas):
{
  "benefits": [
    {
      "benefit_name": "e.g. Private Medical Insurance",
      "benefit_type": "e.g. PMI",
      "employer": "company name or null",
      "currency": "GBP",
      "source_files": ["filename.pdf"],
      "questions": [
        {
          "id": "snake_case_id",
          "question_text": "Field label",
          "section": "Section name",
          "extracted_answer": "value or null",
          "extracted_confidence": "high|medium|low",
          "source": "brief quote",
          "conflict": false,
          "conflict_options": []
        }
      ],
      "conflicts": [],
      "missing": []
    }
  ]
}

Extract every config field per benefit: insurer, policy number, coverage, limits, premiums, contributions, eligibility, waiting periods, exclusions, renewal date, dependants.`;

function cleanJson(str) {
  return str.replace(/,\s*([\]}])/g, '$1');
}
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { files } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) return res.status(400).json({ error: 'No files provided' });

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
        let text; try { text = Buffer.from(b64Data, 'base64').toString('utf-8'); } catch { text = b64Data; }
        contentBlocks.push({ type: 'text', text: '--- Document: ' + (name || 'file') + '---\n' + text });
      }
    }
    if (contentBlocks.length === 0) return res.status(400).json({ error: 'No readable content found' });
    contentBlocks.push({ type: 'text', text: 'Group by benefit type and extract config. Return ONLY the JSON.' });

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 8192, system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: contentBlocks }]
    });

    const responseText = message.content[0]?.text || '';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'No JSON in response', raw: responseText.slice(0, 300) });

    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch { try { parsed = JSON.parse(cleanJson(jsonMatch[0])); } catch (e2) { return res.status(500).json({ error: 'JSON parse failed: ' + e2.message }); } }

    const mapBenefit = (b, idx) => {
      const name = b.benefit_name || 'Unknown Benefit';
      const questions = (b.questions || []).map((q, i) => ({ id: q.id || ('q_' + idx + '_' + i), question_text: q.question_text || q.question || '', section: q.section || 'Configuration', extracted_answer: q.extracted_answer ?? q.extracted ?? q.answer ?? null, extracted_confidence: q.extracted_confidence || q.confidence || 'medium', source: q.source || null, conflict: q.conflict || false, conflict_options: q.conflict_options || [] }));
      return { shell: { benefit_name: name, benefit_type: b.benefit_type || name, benefit_id_external: null, employer: b.employer || null, currency: b.currency || 'GBP' }, questions, question_count: questions.length, conflicts: b.conflicts || [], missing: b.missing || [] };
    };

    const benefits = (parsed.benefits || [parsed]).map(mapBenefit);
    return res.status(200).json({ benefits });

  } catch (err) {
    console.error('Extract error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
