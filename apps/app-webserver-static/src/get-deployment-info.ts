import { getDeterministicUrl } from "./names/get-deterministic-url";

declare const _STD_: Record<string, any>;

// We import this to mock the _STD_ object, which is only available in the Acurast Cloud

export const getDeploymentInfo = () => {
  return {
    vanityUrl: getDeterministicUrl(
      _STD_.device.getAddress(),
      _STD_.job.getId().id
    ),
    version: _STD_.app_info.version,
    deviceAddress: _STD_.device.getAddress(),
    deployment: {
      id: _STD_.job.getId(),
      slot: _STD_.job.getSlot(),
      script: _STD_.scriptHash,
    },
  };
};
