-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID', 'OVERDUE', 'CANCELLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PaymentSource" AS ENUM ('MANUAL', 'EMAIL', 'WHATSAPP', 'INVOICE', 'AI');

-- CreateEnum
CREATE TYPE "BusinessUnit" AS ENUM ('TERAMIND', 'MILA', 'TAURUS', 'DOLCE_MILA', 'HOUSE', 'FAMILY', 'OTHER');

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "payeeName" TEXT NOT NULL,
    "contactId" TEXT,
    "businessUnit" "BusinessUnit" NOT NULL,
    "category" TEXT,
    "description" TEXT,
    "amount" DECIMAL(19,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'DRAFT',
    "invoiceNumber" TEXT,
    "paymentMethod" TEXT,
    "paidAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "notes" TEXT,
    "source" "PaymentSource" NOT NULL DEFAULT 'MANUAL',

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "Payment_businessUnit_idx" ON "Payment"("businessUnit");

-- CreateIndex
CREATE INDEX "Payment_currency_idx" ON "Payment"("currency");

-- CreateIndex
CREATE INDEX "Payment_contactId_idx" ON "Payment"("contactId");

-- CreateIndex
CREATE INDEX "Payment_dueDate_idx" ON "Payment"("dueDate");

-- CreateIndex
CREATE INDEX "Payment_updatedAt_idx" ON "Payment"("updatedAt");

-- CreateIndex
CREATE INDEX "Payment_deletedAt_idx" ON "Payment"("deletedAt");

-- CreateIndex
CREATE INDEX "Payment_payeeName_idx" ON "Payment"("payeeName");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
