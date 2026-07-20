const express = require('express');
const schemas = require('./contactsSchemas');
const contacts = require('./contacts');

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
    const parsed = schemas.listContactsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const result = await contacts.listContacts(parsed.data);
      return res.status(200).json(result);
    } catch (err) {
      console.error('Failed to list contacts:', err instanceof Error ? err.message : 'unknown');
      return res.status(500).json({ error: 'Failed to list contacts' });
    }
  });

  router.get('/:id', async (req, res) => {
    const parsed = schemas.contactIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const contact = await contacts.getContactById(parsed.data.id);
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
    const parsed = schemas.createContactSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const contact = await contacts.createContact(parsed.data);
      return res.status(201).json(contact);
    } catch (err) {
      console.error('Failed to create contact:', err instanceof Error ? err.message : 'unknown');
      return res.status(500).json({ error: 'Failed to create contact' });
    }
  });

  router.patch('/:id', async (req, res) => {
    const params = schemas.contactIdParamSchema.safeParse(req.params);
    if (!params.success) {
      return res.status(400).json(schemas.formatZodError(params.error));
    }

    const body = schemas.updateContactSchema.safeParse(req.body ?? {});
    if (!body.success) {
      return res.status(400).json(schemas.formatZodError(body.error));
    }

    try {
      const contact = await contacts.updateContact(params.data.id, body.data);
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
    const parsed = schemas.contactIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json(schemas.formatZodError(parsed.error));
    }

    try {
      const contact = await contacts.softDeleteContact(parsed.data.id);
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
