import { BackNavigation } from './back-navigation';

describe('native back acknowledgment', () => {
  afterEach(() => jest.useRealTimers());
  it('waits for an explicit matching web result before exiting', () => {
    const send = jest.fn(); const exit = jest.fn(); const back = new BackNavigation(send, exit);
    back.bind('doc-one'); back.request(); const request = send.mock.calls[0][0];
    expect(exit).not.toHaveBeenCalled();
    back.result({ documentId: 'doc-old', requestId: request.requestId, handled: false, canGoBack: false }); expect(exit).not.toHaveBeenCalled();
    back.result({ documentId: 'doc-one', requestId: request.requestId, handled: false, canGoBack: false }); expect(exit).toHaveBeenCalledTimes(1);
  });
  it('never bypasses dirty guard on a delayed response or missing acknowledgment', () => {
    jest.useFakeTimers(); const send = jest.fn(); const exit = jest.fn(); const back = new BackNavigation(send, exit);
    back.bind('doc-one'); back.request(); back.request(); expect(send).toHaveBeenCalledTimes(1);
    const request = send.mock.calls[0][0]; jest.advanceTimersByTime(2000); expect(exit).not.toHaveBeenCalled();
    back.result({ documentId: 'doc-one', requestId: request.requestId, handled: false, canGoBack: false }); expect(exit).not.toHaveBeenCalled();
    back.request(); expect(send).toHaveBeenCalledTimes(2); back.reset();
  });
  it('accepts overlay/route handling without native history moves and invalidates requests on document change', () => {
    const send = jest.fn(); const exit = jest.fn(); const back = new BackNavigation(send, exit);
    back.bind('one'); back.request(); const id = send.mock.calls[0][0].requestId;
    back.result({ documentId: 'one', requestId: id, handled: true, canGoBack: false }); expect(exit).not.toHaveBeenCalled();
    back.request(); const stale = send.mock.calls[1][0].requestId; back.bind('two');
    back.result({ documentId: 'one', requestId: stale, handled: false, canGoBack: false }); expect(exit).not.toHaveBeenCalled(); back.reset();
  });
});
