-- CreateEnum
CREATE TYPE "ContactRole" AS ENUM ('SELF', 'FAMILY', 'SCHOOL', 'TUTOR', 'OTHER');

-- CreateEnum
CREATE TYPE "ConversationChannel" AS ENUM ('WHATSAPP', 'INTERNAL', 'EMAIL');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('RECEIVED', 'DRAFTED', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'REJECTED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "CalendarProposalStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'SCHEDULED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalType" AS ENUM ('MESSAGE_REPLY', 'CALENDAR_EVENT', 'TASK_ACTION', 'OTHER');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RuleCategory" AS ENUM ('MESSAGING', 'CALENDAR', 'TASK', 'SAFETY', 'GENERAL');

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "role" "ContactRole" NOT NULL DEFAULT 'OTHER',
    "notes" TEXT,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" "ConversationChannel" NOT NULL DEFAULT 'INTERNAL',
    "status" "ConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "subject" TEXT,
    "externalId" TEXT,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'RECEIVED',
    "content" TEXT NOT NULL,
    "externalId" TEXT,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "dueAt" TIMESTAMP(3),
    "contactId" TEXT,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarProposal" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "CalendarProposalStatus" NOT NULL DEFAULT 'PROPOSED',
    "contactId" TEXT,
    "calendarEventId" TEXT,

    CONSTRAINT "CalendarProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "type" "ApprovalType" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "summary" TEXT,
    "payload" JSONB,
    "decidedAt" TIMESTAMP(3),
    "messageId" TEXT,
    "taskId" TEXT,
    "calendarProposalId" TEXT,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rule" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "RuleCategory" NOT NULL DEFAULT 'GENERAL',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Contact_phone_idx" ON "Contact"("phone");

-- CreateIndex
CREATE INDEX "Contact_email_idx" ON "Contact"("email");

-- CreateIndex
CREATE INDEX "Conversation_contactId_idx" ON "Conversation"("contactId");

-- CreateIndex
CREATE INDEX "Conversation_status_idx" ON "Conversation"("status");

-- CreateIndex
CREATE INDEX "Conversation_externalId_idx" ON "Conversation"("externalId");

-- CreateIndex
CREATE INDEX "Message_conversationId_idx" ON "Message"("conversationId");

-- CreateIndex
CREATE INDEX "Message_status_idx" ON "Message"("status");

-- CreateIndex
CREATE INDEX "Message_externalId_idx" ON "Message"("externalId");

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE INDEX "Task_contactId_idx" ON "Task"("contactId");

-- CreateIndex
CREATE INDEX "Task_dueAt_idx" ON "Task"("dueAt");

-- CreateIndex
CREATE INDEX "CalendarProposal_status_idx" ON "CalendarProposal"("status");

-- CreateIndex
CREATE INDEX "CalendarProposal_contactId_idx" ON "CalendarProposal"("contactId");

-- CreateIndex
CREATE INDEX "CalendarProposal_startAt_idx" ON "CalendarProposal"("startAt");

-- CreateIndex
CREATE INDEX "Approval_status_idx" ON "Approval"("status");

-- CreateIndex
CREATE INDEX "Approval_type_idx" ON "Approval"("type");

-- CreateIndex
CREATE INDEX "Approval_messageId_idx" ON "Approval"("messageId");

-- CreateIndex
CREATE INDEX "Approval_taskId_idx" ON "Approval"("taskId");

-- CreateIndex
CREATE INDEX "Approval_calendarProposalId_idx" ON "Approval"("calendarProposalId");

-- CreateIndex
CREATE INDEX "Rule_category_idx" ON "Rule"("category");

-- CreateIndex
CREATE INDEX "Rule_enabled_idx" ON "Rule"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "Rule_name_key" ON "Rule"("name");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarProposal" ADD CONSTRAINT "CalendarProposal_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_calendarProposalId_fkey" FOREIGN KEY ("calendarProposalId") REFERENCES "CalendarProposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
