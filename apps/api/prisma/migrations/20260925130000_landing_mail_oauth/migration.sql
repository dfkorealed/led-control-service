CREATE TABLE "LandingMailCredential" (
    "id" TEXT NOT NULL,
    "connectionKey" TEXT NOT NULL,
    "tokenCiphertext" TEXT NOT NULL,
    "tokenIv" TEXT NOT NULL,
    "tokenTag" TEXT NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LandingMailCredential_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LandingMailCredential_singleton" CHECK ("id" = 'naver-works')
);

CREATE TABLE "LandingMailOAuthState" (
    "stateHash" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "connectionKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LandingMailOAuthState_pkey" PRIMARY KEY ("stateHash")
);
CREATE INDEX "LandingMailOAuthState_expiresAt_idx" ON "LandingMailOAuthState"("expiresAt");
