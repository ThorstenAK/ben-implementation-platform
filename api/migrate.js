import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.POSTGRES_URL);

export default async function handler(req, res) {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS implementations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_name TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        implementation_id UUID REFERENCES implementations(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        filetype TEXT,
        text_content TEXT,
        page_count INTEGER,
        uploaded_at TIMESTAMPTZ DEFAULT now()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS benefit_shells (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        implementation_id UUID REFERENCES implementations(id) ON DELETE CASCADE,
        benefit_type TEXT,
        benefit_name TEXT,
        benefit_id_external TEXT,
        currency TEXT DEFAULT 'GBP',
        status TEXT DEFAULT 'review',
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS questions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        benefit_shell_id UUID REFERENCES benefit_shells(id) ON DELETE CASCADE,
        question_key TEXT NOT NULL,
        question_text TEXT NOT NULL,
        section TEXT DEFAULT 'configuration',
        extracted_answer TEXT,
        extracted_confidence TEXT DEFAULT 'missing',
        source_document TEXT,
        source_page INTEGER,
        source_quote TEXT,
        conflict BOOLEAN DEFAULT false,
        conflict_options JSONB,
        confirmed_answer TEXT,
        confirmed_by TEXT,
        confirmed_at TIMESTAMPTZ,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `;

    res.status(200).json({ ok: true, message: 'All tables created' });
  } catch (err) {
    console.error('Migration error:', err);
    res.status(500).json({ error: err.message });
  }
}
