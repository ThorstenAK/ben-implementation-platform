import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const config = {
  maxDuration: 60,
  api: { bodyParser: { sizeLimit: '20mb' } }
};

const IDENTIFY_PROMPT = `You are analyzing employee benefits documents. List every distinct benefit type covered in these documents.
Return ONLY valid JSON: { "benefits": [{ "name": "Full benefit name", "type": "Category" }, ...] }
Be specific with names (e.g. "Private Medical Insurance", "Group Life Assurance", "Bikes for Work").
Do not group — list each benefit separately.
Type should be the category: Insurance, Pension, Salary Sacrifice, Allowance, Wellbeing, etc.`;

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { files } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const contentBlocks = buildContentBlocks(files);
    if (contentBlocks.length === 0) return res.status(400).json({ error: 'No readable content found' });

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: IDENTIFY_PROMPT,
      messages: [{
        role: 'user',
        content: [...contentBlocks, { type: 'text', text: 'List all distinct benefit types covered in these documents.' }]
      }]
    });

    const raw = msg.content[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(200).json({ benefits: [] });

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0].replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return res.status(200).json({ benefits: [] });
    }

    const benefits = Array.isArray(parsed.benefits) ? parsed.benefits.map(b =>
      typeof b === 'string' ? { name: b, type: 'Benefit' } : { name: b.name || b, type: b.type || 'Benefit' }
    ) : [];

    return res.status(200).json({ benefits });

  } catch (err) {
    console.error('Identify error:', err);
    return res.status(500).json({ error: err.message });
  }
}
