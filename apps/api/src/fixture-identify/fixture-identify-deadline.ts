import { ServiceUnavailableException } from "@nestjs/common";

/** Redis reconnect/offline queues must not turn a short physical operation into an unbounded HTTP wait. */
export function identifyCoordinationDeadline<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new ServiceUnavailableException("identify_coordination_unavailable")), 500);
    void operation.then((value) => { clearTimeout(timeout); resolve(value); }, (error) => { clearTimeout(timeout); reject(error); });
  });
}
