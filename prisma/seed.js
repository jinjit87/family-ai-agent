/**
 * Seed foundational sample data for local / Railway setup.
 * Creates: one Contact, one Conversation, one Task.
 *
 * Usage: npm run db:seed
 * Requires: DATABASE_URL
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const contact = await prisma.contact.upsert({
    where: { id: 'seed_contact_meytal' },
    update: {
      name: 'Meytal',
      phone: '+972500000000',
      email: 'meytal@example.com',
      company: null,
      role: 'SELF',
      notes: 'Primary family assistant owner (seed)',
      deletedAt: null,
    },
    create: {
      id: 'seed_contact_meytal',
      name: 'Meytal',
      phone: '+972500000000',
      email: 'meytal@example.com',
      company: null,
      role: 'SELF',
      notes: 'Primary family assistant owner (seed)',
    },
  });

  const conversation = await prisma.conversation.upsert({
    where: { id: 'seed_conversation_internal' },
    update: {
      contactId: contact.id,
      channel: 'INTERNAL',
      status: 'ACTIVE',
      subject: 'Family assistant onboarding',
    },
    create: {
      id: 'seed_conversation_internal',
      contactId: contact.id,
      channel: 'INTERNAL',
      status: 'ACTIVE',
      subject: 'Family assistant onboarding',
    },
  });

  const task = await prisma.task.upsert({
    where: { id: 'seed_task_review_calendar' },
    update: {
      title: 'Review upcoming family calendar',
      description: 'Confirm school and activity events for the next week.',
      status: 'OPEN',
      priority: 'MEDIUM',
      source: 'MANUAL',
      contactId: contact.id,
      conversationId: conversation.id,
      completedAt: null,
    },
    create: {
      id: 'seed_task_review_calendar',
      title: 'Review upcoming family calendar',
      description: 'Confirm school and activity events for the next week.',
      status: 'OPEN',
      priority: 'MEDIUM',
      source: 'MANUAL',
      contactId: contact.id,
      conversationId: conversation.id,
    },
  });

  console.log('Seed complete:');
  console.log(`  Contact:      ${contact.id} (${contact.name})`);
  console.log(`  Conversation: ${conversation.id} (${conversation.subject})`);
  console.log(`  Task:         ${task.id} (${task.title})`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
