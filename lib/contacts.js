const { getPrisma } = require('./db');
const { SORT_FIELDS } = require('./contactsSchemas');

/**
 * @typedef {object} ContactRecord
 * @property {string} id
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} name
 * @property {string | null} phone
 * @property {string | null} email
 * @property {string | null} company
 * @property {string} role
 * @property {string | null} notes
 */

/**
 * Serialize a Prisma contact for JSON responses.
 * @param {ContactRecord} contact
 */
function serializeContact(contact) {
  return {
    id: contact.id,
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
    deletedAt: contact.deletedAt ? contact.deletedAt.toISOString() : null,
    name: contact.name,
    phone: contact.phone,
    email: contact.email,
    company: contact.company,
    role: contact.role,
    notes: contact.notes,
  };
}

/**
 * Active (non-soft-deleted) contacts only.
 */
function activeWhere(extra = {}) {
  return {
    deletedAt: null,
    ...extra,
  };
}

/**
 * Build Prisma OR search filters for name/email/phone/company.
 * @param {string | undefined} q
 */
function buildSearchWhere(q) {
  if (!q) {
    return activeWhere();
  }

  const term = q.trim();
  if (!term) {
    return activeWhere();
  }

  return activeWhere({
    OR: [
      { name: { contains: term, mode: 'insensitive' } },
      { email: { contains: term, mode: 'insensitive' } },
      { phone: { contains: term, mode: 'insensitive' } },
      { company: { contains: term, mode: 'insensitive' } },
    ],
  });
}

/**
 * @param {'name' | 'updatedAt'} sort
 */
function buildOrderBy(sort) {
  if (sort === 'updatedAt') {
    return { updatedAt: 'desc' };
  }
  return { name: 'asc' };
}

/**
 * List contacts with optional search, pagination, and sorting.
 * Soft-deleted contacts are excluded.
 * @param {{ q?: string, page: number, limit: number, sort: 'name' | 'updatedAt' }} query
 */
async function listContacts(query) {
  const prisma = getPrisma();
  const where = buildSearchWhere(query.q);
  const sort = SORT_FIELDS.includes(query.sort) ? query.sort : 'name';
  const skip = (query.page - 1) * query.limit;

  const [total, rows] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where,
      orderBy: buildOrderBy(sort),
      skip,
      take: query.limit,
    }),
  ]);

  const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);

  return {
    data: rows.map(serializeContact),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
    },
  };
}

/**
 * Get one active contact by id.
 * @param {string} id
 * @returns {Promise<object | null>}
 */
async function getContactById(id) {
  const prisma = getPrisma();
  const contact = await prisma.contact.findFirst({
    where: activeWhere({ id }),
  });
  return contact ? serializeContact(contact) : null;
}

/**
 * Create a contact.
 * @param {object} input
 */
async function createContact(input) {
  const prisma = getPrisma();
  const contact = await prisma.contact.create({
    data: {
      name: input.name,
      phone: input.phone ?? null,
      email: input.email ?? null,
      company: input.company ?? null,
      role: input.role ?? 'OTHER',
      notes: input.notes ?? null,
    },
  });
  return serializeContact(contact);
}

/**
 * Patch an active contact. Returns null if missing or soft-deleted.
 * @param {string} id
 * @param {object} input
 */
async function updateContact(id, input) {
  const prisma = getPrisma();
  const existing = await prisma.contact.findFirst({
    where: activeWhere({ id }),
  });
  if (!existing) {
    return null;
  }

  const contact = await prisma.contact.update({
    where: { id },
    data: input,
  });
  return serializeContact(contact);
}

/**
 * Soft-delete a contact by setting deletedAt.
 * Never permanently deletes. Returns null if missing or already deleted.
 * @param {string} id
 */
async function softDeleteContact(id) {
  const prisma = getPrisma();
  const existing = await prisma.contact.findFirst({
    where: activeWhere({ id }),
  });
  if (!existing) {
    return null;
  }

  const contact = await prisma.contact.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  return serializeContact(contact);
}

module.exports = {
  serializeContact,
  buildSearchWhere,
  buildOrderBy,
  listContacts,
  getContactById,
  createContact,
  updateContact,
  softDeleteContact,
};
