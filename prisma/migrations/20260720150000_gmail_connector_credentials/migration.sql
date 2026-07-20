-- Gmail connector MVP: encrypted per-account credentials + sync status fields

-- AlterTable
ALTER TABLE "InboxAccount" ADD COLUMN "syncStatus" TEXT;
ALTER TABLE "InboxAccount" ADD COLUMN "lastSyncError" TEXT;

-- CreateIndex
CREATE INDEX "InboxAccount_externalAccountId_idx" ON "InboxAccount"("externalAccountId");

-- CreateTable
CREATE TABLE "GmailCredential" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "inboxAccountId" TEXT NOT NULL,
    "encryptedAccessToken" TEXT,
    "encryptedRefreshToken" TEXT NOT NULL,
    "tokenExpiry" TIMESTAMP(3),
    "scopes" TEXT NOT NULL,

    CONSTRAINT "GmailCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GmailCredential_inboxAccountId_key" ON "GmailCredential"("inboxAccountId");

-- AddForeignKey
ALTER TABLE "GmailCredential" ADD CONSTRAINT "GmailCredential_inboxAccountId_fkey" FOREIGN KEY ("inboxAccountId") REFERENCES "InboxAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
