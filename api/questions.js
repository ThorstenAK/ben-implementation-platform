import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.POSTGRES_URL);

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const { benefit_shell_id } = req.query;
    if (!benefit_shell_id) return res.status(400).json({ error: 'benefit_shell_id required' });

    try {
      const [shell] = await sql`
        SELECT * FROM benefit_shells WHERE id = ${benefit_shell_id}
      `;
      if (!shell) return res.status(404).json({ error: 'Benefit shell not found' });

      const questions = await sql`
        SELECT * FROM questions
        WHERE benefit_shell_id = ${benefit_shell_id}
        ORDER BY sort_order ASC, created_at ASC
      `;

      const stats = {
        total: questions.length,
        high: questions.filter(q => q.extracted_confidence === 'high').length,
        medium: questions.filter(q => q.extracted_confidence === 'medium').length,
        missing: questions.filter(q => q.extracted_confidence === 'missing').length,
        conflict: questions.filter(q => q.conflict).length,
        confirmed: questions.filter(q => q.confirmed_at).length
      };

      res.status(200).json({ shell, questions, stats });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }

  } else if (req.method === 'POST') {
    const { question_id, action, answer, confirmed_by } = req.body;
    if (!question_id) return res.status(400).json({ error: 'question_id required' });

    try {
      if (action === 'confirm') {
        const [q] = await sql`
          UPDATE questions
          SET
            confirmed_answer = ${answer ?? null},
            confirmed_by = ${confirmed_by || 'IM'},
            confirmed_at = now()
          WHERE id = ${question_id}
          RETURNING *
        `;
        res.status(200).json({ data: q });

      } else if (action === 'resolve_conflict') {
        const { resolved_value } = req.body;
        const [q] = await sql`
          UPDATE questions
          SET
            confirmed_answer = ${resolved_value},
            confirmed_by = ${confirmed_by || 'IM'},
            confirmed_at = now()
          WHERE id = ${question_id}
          RETURNING *
        `;
        res.status(200).json({ data: q });

      } else {
        res.status(400).json({ error: 'action must be confirm or resolve_conflict' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }

  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
           }
