-- CreateEnum
CREATE TYPE "InboxAccountSource" AS ENUM ('GMAIL', 'OUTLOOK', 'WHATSAPP', 'SMS', 'MANUAL', 'API');

-- CreateEnum
CREATE TYPE "InboxStatus" AS ENUM ('NEW', 'PROCESSING', 'READY_FOR_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED', 'FAILED');

-- CreateEnum
CREATE TYPE "Urgency" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'APPLIED');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "inboxItemId" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "inboxItemId" TEXT;

-- CreateTable
CREATE TABLE "InboxAccount" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "source" "InboxAccountSource" NOT NULL,
    "emailAddress" TEXT,
    "externalAccountId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "syncCursor" TEXT,

    CONSTRAINT "InboxAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxItem" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "inboxAccountId" TEXT NOT NULL,
    "source" "InboxAccountSource" NOT NULL,
    "externalId" TEXT NOT NULL,
    "threadExternalId" TEXT,
    "senderName" TEXT,
    "senderIdentifier" TEXT NOT NULL,
    "recipients" JSONB,
    "subject" TEXT,
    "rawContent" TEXT NOT NULL,
    "summary" TEXT,
    "status" "InboxStatus" NOT NULL DEFAULT 'NEW',
    "confidence" DOUBLE PRECISION,
    "urgency" "Urgency",
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "InboxItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxTaskSuggestion" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "inboxItemId" TEXT NOT NULL,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" "TaskPriority",
    "dueDate" TIMESTAMP(3),
    "contactId" TEXT,
    "evidence" JSONB,
    "appliedTaskId" TEXT,

    CONSTRAINT "InboxTaskSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxPaymentSuggestion" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "inboxItemId" TEXT NOT NULL,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "payeeName" TEXT NOT NULL,
    "amount" DECIMAL(19,4),
    "currency" CHAR(3),
    "dueDate" TIMESTAMP(3),
    "businessUnit" "BusinessUnit",
    "category" TEXT,
    "description" TEXT,
    "invoiceNumber" TEXT,
    "evidence" JSONB,
    "appliedPaymentId" TEXT,

    CONSTRAINT "InboxPaymentSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxReplySuggestion" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "inboxItemId" TEXT NOT NULL,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "replyText" TEXT NOT NULL,
    "evidence" JSONB,

    CONSTRAINT "InboxReplySuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboxAccount_source_idx" ON "InboxAccount"("source");

-- CreateIndex
CREATE INDEX "InboxAccount_isActive_idx" ON "InboxAccount"("isActive");

-- CreateIndex
CREATE INDEX "InboxAccount_emailAddress_idx" ON "InboxAccount"("emailAddress");

-- CreateIndex
CREATE INDEX "InboxAccount_updatedAt_idx" ON "InboxAccount"("updatedAt");

-- CreateIndex
CREATE INDEX "InboxItem_inboxAccountId_idx" ON "InboxItem"("inboxAccountId");

-- CreateIndex
CREATE INDEX "InboxItem_source_idx" ON "InboxItem"("source");

-- CreateIndex
CREATE INDEX "InboxItem_status_idx" ON "InboxItem"("status");

-- CreateIndex
CREATE INDEX "InboxItem_urgency_idx" ON "InboxItem"("urgency");

-- CreateIndex
CREATE INDEX "InboxItem_senderIdentifier_idx" ON "InboxItem"("senderIdentifier");

-- CreateIndex
CREATE INDEX "InboxItem_receivedAt_idx" ON "InboxItem"("receivedAt");

-- CreateIndex
CREATE INDEX "InboxItem_updatedAt_idx" ON "InboxItem"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboxItem_inboxAccountId_externalId_key" ON "InboxItem"("inboxAccountId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "InboxTaskSuggestion_appliedTaskId_key" ON "InboxTaskSuggestion"("appliedTaskId");

-- CreateIndex
CREATE INDEX "InboxTaskSuggestion_inboxItemId_idx" ON "InboxTaskSuggestion"("inboxItemId");

-- CreateIndex
CREATE INDEX "InboxTaskSuggestion_status_idx" ON "InboxTaskSuggestion"("status");

-- CreateIndex
CREATE UNIQUE INDEX "InboxPaymentSuggestion_appliedPaymentId_key" ON "InboxPaymentSuggestion"("appliedPaymentId");

-- CreateIndex
CREATE INDEX "InboxPaymentSuggestion_inboxItemId_idx" ON "InboxPaymentSuggestion"("inboxItemId");

-- CreateIndex
CREATE INDEX "InboxPaymentSuggestion_status_idx" ON "InboxPaymentSuggestion"("status");

-- CreateIndex
CREATE INDEX "InboxReplySuggestion_inboxItemId_idx" ON "InboxReplySuggestion"("inboxItemId");

-- CreateIndex
CREATE INDEX "InboxReplySuggestion_status_idx" ON "InboxReplySuggestion"("status");

-- CreateIndex
CREATE INDEX "Payment_inboxItemId_idx" ON "Payment"("inboxItemId");

-- CreateIndex
CREATE INDEX "Task_inboxItemId_idx" ON "Task"("inboxItemId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_inboxItemId_fkey" FOREIGN KEY ("inboxItemId") REFERENCES "InboxItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_inboxItemId_fkey" FOREIGN KEY ("inboxItemId") REFERENCES "InboxItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxItem" ADD CONSTRAINT "InboxItem_inboxAccountId_fkey" FOREIGN KEY ("inboxAccountId") REFERENCES "InboxAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxTaskSuggestion" ADD CONSTRAINT "InboxTaskSuggestion_inboxItemId_fkey" FOREIGN KEY ("inboxItemId") REFERENCES "InboxItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxTaskSuggestion" ADD CONSTRAINT "InboxTaskSuggestion_appliedTaskId_fkey" FOREIGN KEY ("appliedTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxPaymentSuggestion" ADD CONSTRAINT "InboxPaymentSuggestion_inboxItemId_fkey" FOREIGN KEY ("inboxItemId") REFERENCES "InboxItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxPaymentSuggestion" ADD CONSTRAINT "InboxPaymentSuggestion_appliedPaymentId_fkey" FOREIGN KEY ("appliedPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxReplySuggestion" ADD CONSTRAINT "InboxReplySuggestion_inboxItemId_fkey" FOREIGN KEY ("inboxItemId") REFERENCES "InboxItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

