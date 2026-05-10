import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.POSTGRES_URL);

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const implementations = await sql`
        SELECT
          i.id,
          i.customer_name,
          i.status,
          i.created_at,
          COUNT(DISTINCT b.id) AS benefit_count,
          COUNT(DISTINCT d.id) AS document_count
        FROM implementations i
        LEFT JOIN benefit_shells b ON b.implementation_id = i.id
        LEFT JOIN documents d ON d.implementation_id = i.id
        GROUP BY i.id
        ORDER BY i.created_at DESC
      `;
      res.status(200).json({ data: implementations });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  } else if (req.method === 'POST') {
    const { customer_name } = req.body;
    if (!customer_name?.trim()) {
      return res.status(400).json({ error: 'customer_name is required' });
    }
    try {
      const [impl] = await sql`
        INSERT INTO implementations (customer_name)
        VALUES (${customer_name.trim()})
        RETURNING *
      `;
      res.status(201).json({ data: impl });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  } else if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id is required' });
    try {
      await sql`DELETE FROM questions WHERE benefit_id IN (SELECT id FROM benefit_shells WHERE implementation_id = ${id})`;
      await sql`DELETE FROM benefit_shells WHERE implementation_id = ${id}`;
      await sql`DELETE FROM documents WHERE implementation_id = ${id}`;
      await sql`DELETE FROM implementations WHERE id = ${id}`;
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}
