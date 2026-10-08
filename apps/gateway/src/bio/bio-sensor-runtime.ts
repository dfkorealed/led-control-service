import { FileBioSensorProfileCatalog, type BioSensorScope } from "./bio-sensor-profile-catalog";
import { BioNodeLinkMonitor } from "./bio-node-link-monitor";
import { CommissionedBioPulseAuthorityProvider } from "./bio-pulse-authority-provider";
import { BioSensorPreparationHandler } from "../commands/bio-sensor-preparation-handler";
import { CommandJournal } from "../commands/command-journal";
import type { BioCapabilityDeliveryController } from "./bio-capability-delivery";
import type { GatewayAdapters } from "../adapters/adapter-factory";

/** Owns catalog/source/commission lifetime together. No environment value supplies approval. */
export async function createBioSensorRuntime(hardware: NonNullable<GatewayAdapters["bioSensorHardware"]>,
  delivery: BioCapabilityDeliveryController, scope: BioSensorScope, path: string, clockTrusted: () => Promise<boolean>) {
  const catalog = new FileBioSensorProfileCatalog(`${path}.catalog`, scope); await catalog.initialize();
  const monitor = new BioNodeLinkMonitor({ ...hardware, catalog, onProbe: async proof => {
    await delivery.recordLiveProof(proof); await delivery.wake();
  } });
  delivery.setLiveProofReader(id => monitor.snapshot(id));
  const authority = new CommissionedBioPulseAuthorityProvider({ scope, catalog, monitor, delivery });
  hardware.source.configure(catalog, authority);
  const preparation = new BioSensorPreparationHandler({ ...hardware, scope, catalog, journal: new CommandJournal(`${path}.preparations`), clockTrusted,
    onCommission: proof => { monitor.commission(proof); void monitor.probe(proof.command.fixtureId); },
    onInvalidate: id => monitor.invalidate(id) });
  monitor.start();
  return { catalog, monitor, authority, preparation,
    disconnect() { preparation.disconnect(); monitor.invalidate(); delivery.invalidateCommissionProofs(); },
    async stopAndDrain() { await preparation.stopAndDrain(); await monitor.stopAndDrain(); authority.stop(); }
  };
}
