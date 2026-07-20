-- Gmail security amendment: sync lease lock + one-time OAuth state table

-- AlterTable
ALTER TABLE "InboxAccount" ADD COLUMN "syncLockExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "GmailOAuthState" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nonce" TEXT NOT NULL,
    "flow" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "GmailOAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GmailOAuthState_nonce_key" ON "GmailOAuthState"("nonce");

-- CreateIndex
CREATE INDEX "GmailOAuthState_expiresAt_idx" ON "GmailOAuthState"("expiresAt");

-- CreateIndex
CREATE INDEX "GmailOAuthState_flow_idx" ON "GmailOAuthState"("flow");
