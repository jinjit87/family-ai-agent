const express = require('express');
const {
  createContactSchema,
  updateContactSchema,
  listContactsQuerySchema,
  contactIdParamSchema,
  formatZodError,
} = require('./contactsSchemas');
const {
  listContacts,
  getContactById,
  createContact,
  updateContact,
  softDeleteContact,
} = require('./contacts');

/**
 * Express router for Contacts CRUD (Phase 3).
 * Mount under /contacts with admin auth. Does not alter existing routes.
 *
 * @param {{ adminAuth: import('express').RequestHandler }} options
 */
function createContactsRouter({ adminAuth }) {
  const router = express.Router();

  router.use(adminAuth);

  router.get('/', async (req, res) => {
    const parsed = listContactsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json(formatZodError(parsed.error));
    }

    try {
      const result = await listContacts(parsed.data);
      return res.status(200).json(result);
    } catch (err) {
      console.error('Failed to list contacts:', err instanceof Error ? err.message : 'unknown');
      return res.status(500).json({ error: 'Failed to list contacts' });
    }
  });

  router.get('/:id', async (req, res) => {
    const parsed = contactIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(formatZodError(parsed.error));
    }

    try {
      const contact = await getContactById(parsed.data.id);
      if (!contact) {
        return res.status(404).json({ error: 'Contact not found' });
      }
      return res.status(200).json(contact);
    } catch (err) {
      console.error('Failed to get contact:', err instanceof Error ? err.message : 'unknown');
      return res.status(500).json({ error: 'Failed to get contact' });
    }
  });

  router.post('/', async (req, res) => {
    const parsed = createContactSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(formatZodError(parsed.error));
    }

    try {
      const contact = await createContact(parsed.data);
      return res.status(201).json(contact);
    } catch (err) {
      console.error('Failed to create contact:', err instanceof Error ? err.message : 'unknown');
      return res.status(500).json({ error: 'Failed to create contact' });
    }
  });

  router.patch('/:id', async (req, res) => {
    const params = contactIdParamSchema.safeParse(req.params);
    if (!params.success) {
      return res.status(400).json(formatZodError(params.error));
    }

    const body = updateContactSchema.safeParse(req.body ?? {});
    if (!body.success) {
      return res.status(400).json(formatZodError(body.error));
    }

    try {
      const contact = await updateContact(params.data.id, body.data);
      if (!contact) {
        return res.status(404).json({ error: 'Contact not found' });
      }
      return res.status(200).json(contact);
    } catch (err) {
      console.error('Failed to update contact:', err instanceof Error ? err.message : 'unknown');
      return res.status(500).json({ error: 'Failed to update contact' });
    }
  });

  router.delete('/:id', async (req, res) => {
    const parsed = contactIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(formatZodError(parsed.error));
    }

    try {
      const contact = await softDeleteContact(parsed.data.id);
      if (!contact) {
        return res.status(404).json({ error: 'Contact not found' });
      }
      return res.status(200).json(contact);
    } catch (err) {
      console.error('Failed to delete contact:', err instanceof Error ? err.message : 'unknown');
      return res.status(500).json({ error: 'Failed to delete contact' });
    }
  });

  return router;
}

module.exports = {
  createContactsRouter,
};
