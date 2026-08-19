ALTER TABLE "Floor"
ADD COLUMN "nextFixtureSequence" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Gateway"
ADD COLUMN "nextMeshUnicastAddress" INTEGER NOT NULL DEFAULT 256;

-- 기존 노드가 있는 게이트웨이는 사용 중인 주소 다음부터 예약하도록 보정한다.
UPDATE "Gateway" AS gateway
SET "nextMeshUnicastAddress" = GREATEST(
  256,
  COALESCE(
    (
      SELECT MAX(
        get_byte(decode(lpad(substring(node."meshAddress" FROM 3), 4, '0'), 'hex'), 0) * 256
        + get_byte(decode(lpad(substring(node."meshAddress" FROM 3), 4, '0'), 'hex'), 1)
        + 1
      )
      FROM "MeshNode" AS node
      WHERE node."gatewayId" = gateway.id
        AND node."meshAddress" ~ '^0x[0-9A-Fa-f]{1,4}$'
    ),
    256
  )
);
