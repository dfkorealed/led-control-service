BEGIN;
SELECT "lock_automation_membership_mutation"();

-- Metadata/telemetry writers already hold Site/Fixture rows. Requiring the
-- global serializer on their ordinary UPDATE creates Site <-> membership
-- inversion. Identity/admission and retirement still acquire it before rows;
-- all pending/retired row guards remain installed for ordinary UPDATE.
DO $$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['FixtureRegistrationRemovalOperation','Fixture','MeshNode','Gateway','GroupFixture',
      'CommandFixtureResult','AutomationExecutionFixtureResult','FloorLightSlot','MeshControlGroupMember','SensorModeOperation',
      'BioSensorPreparationOperation','BioRegistrationRevalidationOperation'] LOOP
    EXECUTE format('DROP TRIGGER %I ON %I',name||'_registration_removal_lock',name);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"()',name||'_registration_removal_lock',name);
  END LOOP;
END $$;
CREATE TRIGGER "Fixture_registration_binding_lock" BEFORE UPDATE OF id,"meshNodeId","gatewayId","siteId","floorId","retiredAt" ON "Fixture"
  FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();
CREATE TRIGGER "MeshNode_registration_binding_lock" BEFORE UPDATE OF id,"gatewayId","deviceUuid","meshAddress","vehicleSensorProtocol","retiredAt" ON "MeshNode"
  FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();
CREATE TRIGGER "Gateway_registration_binding_lock" BEFORE UPDATE OF id,"siteId","serialNumber","assignmentVersion" ON "Gateway"
  FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();
CREATE TRIGGER "GroupFixture_registration_binding_lock" BEFORE UPDATE OF "fixtureId","groupId" ON "GroupFixture"
  FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();
CREATE TRIGGER "CommandFixtureResult_registration_binding_lock" BEFORE UPDATE OF "fixtureId","dispatchId" ON "CommandFixtureResult"
  FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();
CREATE TRIGGER "AutomationExecutionFixtureResult_registration_binding_lock" BEFORE UPDATE OF "fixtureId","executionId" ON "AutomationExecutionFixtureResult"
  FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();
CREATE TRIGGER "FloorLightSlot_registration_binding_lock" BEFORE UPDATE OF "assignedFixtureId" ON "FloorLightSlot"
  FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();
CREATE TRIGGER "MeshControlGroupMember_registration_binding_lock" BEFORE UPDATE OF "meshNodeId","desired" ON "MeshControlGroupMember"
  FOR EACH STATEMENT EXECUTE FUNCTION "lock_automation_membership_statement"();

-- Whole-Site deletion is a distinct existing destructive operation. Let its
-- own FK remove this ledger; do not let per-Fixture/Node deletion remove it.
-- Deferred NO ACTION supports either ordering of the Site's FK cascades while
-- still rejecting dangling references at commit for every other delete path.
ALTER TABLE "FixtureRegistrationRemovalOperation"
  DROP CONSTRAINT "FixtureRegistrationRemovalOperation_fixture_fkey",
  DROP CONSTRAINT "FixtureRegistrationRemovalOperation_node_fkey",
  ADD CONSTRAINT "FixtureRegistrationRemovalOperation_fixture_fkey" FOREIGN KEY ("fixtureId","siteId")
    REFERENCES "Fixture"(id,"siteId") ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "FixtureRegistrationRemovalOperation_node_fkey" FOREIGN KEY ("meshNodeId","gatewayId")
    REFERENCES "MeshNode"(id,"gatewayId") ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "FixtureRegistrationRemovalOperation_site_fkey" FOREIGN KEY ("siteId")
    REFERENCES "Site"(id) ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE FUNCTION guard_fixture_registration_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE site_id TEXT; has_operation BOOLEAN;
BEGIN
  IF TG_TABLE_NAME='FixtureRegistrationRemovalOperation' THEN
    site_id:=OLD."siteId"; has_operation:=true;
  ELSIF TG_TABLE_NAME='Fixture' THEN
    site_id:=OLD."siteId";
    SELECT EXISTS(SELECT 1 FROM "FixtureRegistrationRemovalOperation" WHERE "fixtureId"=OLD.id) INTO has_operation;
  ELSE
    -- Retained snapshot attribution survives deletion of Gateway earlier in a
    -- Site cascade. A missing/unknown attribution never authorizes a bypass.
    SELECT "siteId" INTO site_id FROM "FixtureRegistrationRemovalOperation" WHERE "meshNodeId"=OLD.id LIMIT 1;
    has_operation:=FOUND;
    IF site_id IS NULL THEN SELECT "siteId" INTO site_id FROM "Gateway" WHERE id=OLD."gatewayId"; END IF;
  END IF;
  IF site_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "Site" WHERE id=site_id) THEN
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME='FixtureRegistrationRemovalOperation' THEN
    RAISE EXCEPTION 'registration removal evidence cannot be deleted' USING ERRCODE='23514';
  ELSIF OLD."retiredAt" IS NOT NULL OR has_operation THEN
    RAISE EXCEPTION 'retained registration cannot be physically deleted' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;

-- Separate DELETE from the unchanged insert/update validation functions so
-- parent teardown cannot weaken immutable identity, result or retirement checks.
DROP TRIGGER "FixtureRegistrationRemovalOperation_guard" ON "FixtureRegistrationRemovalOperation";
CREATE TRIGGER "FixtureRegistrationRemovalOperation_guard" BEFORE INSERT OR UPDATE ON "FixtureRegistrationRemovalOperation"
  FOR EACH ROW EXECUTE FUNCTION guard_fixture_registration_removal_operation();
DROP TRIGGER "Fixture_registration_retirement_guard" ON "Fixture";
CREATE TRIGGER "Fixture_registration_retirement_guard" BEFORE UPDATE ON "Fixture"
  FOR EACH ROW EXECUTE FUNCTION guard_fixture_registration_retirement();
DROP TRIGGER "MeshNode_registration_retirement_guard" ON "MeshNode";
CREATE TRIGGER "MeshNode_registration_retirement_guard" BEFORE UPDATE ON "MeshNode"
  FOR EACH ROW EXECUTE FUNCTION guard_fixture_registration_retirement();
CREATE TRIGGER "FixtureRegistrationRemovalOperation_delete_guard" BEFORE DELETE ON "FixtureRegistrationRemovalOperation"
  FOR EACH ROW EXECUTE FUNCTION guard_fixture_registration_delete();
CREATE TRIGGER "Fixture_registration_delete_guard" BEFORE DELETE ON "Fixture"
  FOR EACH ROW EXECUTE FUNCTION guard_fixture_registration_delete();
CREATE TRIGGER "MeshNode_registration_delete_guard" BEFORE DELETE ON "MeshNode"
  FOR EACH ROW EXECUTE FUNCTION guard_fixture_registration_delete();

-- AFTER DELETE sees the actual removed Site, not a caller-controlled flag.
-- PostgreSQL runs same-event triggers by name: this precedes RI_* cascades so
-- Gateway and immutable operation attribution are still available to guards.
CREATE FUNCTION cleanup_deleted_site_fixture_registrations() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM "Site" WHERE id=OLD.id) THEN
    RAISE EXCEPTION 'Site must actually be deleted before registration cleanup' USING ERRCODE='23514';
  END IF;
  DELETE FROM "Fixture" WHERE "siteId"=OLD.id AND id IN
    (SELECT "fixtureId" FROM "FixtureRegistrationRemovalOperation" WHERE "siteId"=OLD.id);
  DELETE FROM "MeshNode" WHERE id IN
    (SELECT "meshNodeId" FROM "FixtureRegistrationRemovalOperation" WHERE "siteId"=OLD.id);
  RETURN OLD;
END $$;
CREATE TRIGGER "AAA_fixture_registration_site_teardown" AFTER DELETE ON "Site"
  FOR EACH ROW EXECUTE FUNCTION cleanup_deleted_site_fixture_registrations();
COMMIT;
