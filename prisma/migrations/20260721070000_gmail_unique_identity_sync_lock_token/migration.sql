-- Gmail production readiness:
-- 1) Deduplicate (source, externalAccountId) before unique constraint
-- 2) Add syncLockToken for ownership-safe leases
-- 3) Enforce @@unique([source, externalAccountId])

-- Audit + cleanup: keep the newest row that has credentials when possible;
-- delete older duplicates only when they have no InboxItems.
WITH ranked AS (
  SELECT
    a.id,
    a.source,
    a."externalAccountId",
    ROW_NUMBER() OVER (
      PARTITION BY a.source, a."externalAccountId"
      ORDER BY
        CASE WHEN g.id IS NOT NULL THEN 0 ELSE 1 END,
        a."updatedAt" DESC,
        a."createdAt" DESC
    ) AS rn
  FROM "InboxAccount" a
  LEFT JOIN "GmailCredential" g ON g."inboxAccountId" = a.id
  WHERE a."externalAccountId" IS NOT NULL
)
DELETE FROM "GmailCredential" gc
USING ranked r
WHERE gc."inboxAccountId" = r.id
  AND r.rn > 1
  AND NOT EXISTS (
    SELECT 1 FROM "InboxItem" i WHERE i."inboxAccountId" = r.id
  );

WITH ranked AS (
  SELECT
    a.id,
    ROW_NUMBER() OVER (
      PARTITION BY a.source, a."externalAccountId"
      ORDER BY
        CASE WHEN g.id IS NOT NULL THEN 0 ELSE 1 END,
        a."updatedAt" DESC,
        a."createdAt" DESC
    ) AS rn
  FROM "InboxAccount" a
  LEFT JOIN "GmailCredential" g ON g."inboxAccountId" = a.id
  WHERE a."externalAccountId" IS NOT NULL
)
DELETE FROM "InboxAccount" a
USING ranked r
WHERE a.id = r.id
  AND r.rn > 1
  AND NOT EXISTS (
    SELECT 1 FROM "InboxItem" i WHERE i."inboxAccountId" = a.id
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "InboxAccount"
    WHERE "externalAccountId" IS NOT NULL
    GROUP BY source, "externalAccountId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot add unique(source, externalAccountId): duplicate Gmail identities still have InboxItems. Resolve manually before migrating.';
  END IF;
END $$;

ALTER TABLE "InboxAccount" ADD COLUMN IF NOT EXISTS "syncLockToken" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "InboxAccount_source_externalAccountId_key"
  ON "InboxAccount" ("source", "externalAccountId");
