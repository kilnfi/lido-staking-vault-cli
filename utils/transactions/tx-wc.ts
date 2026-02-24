import {
  encodeFunctionData,
  Hex,
  SimulateCallsReturnType,
  Abi,
  WalletClient,
} from 'viem';
import { waitForTransactionReceipt } from 'viem/actions';

import { getPublicClient, getWalletConnectClient } from 'providers';
import { getChain } from 'configs';
import {
  showSpinner,
  printError,
  logResult,
  disconnectWalletConnect,
  logInfo,
  logError,
} from 'utils';

import { PartialContract, PopulatedTx, BatchTxArgs } from './types.js';
import { simulateCallsErrorHandler } from './utils.js';

export const PROVIDER_POLLING_INTERVAL = 12_000;
export const AA_TX_POLLING_TIMEOUT = 180_000; // 3 minutes

export const isPopulatedTx = (tx: any): tx is PopulatedTx => {
  return !!tx && tx.to !== undefined && tx.data !== undefined;
};

export const simulateWCWriteTx = async (args: {
  calls: PopulatedTx[];
  withSpinner?: boolean;
  skipError?: boolean;
  abi?: Abi;
}): Promise<SimulateCallsReturnType<PopulatedTx[]>> => {
  const { calls, withSpinner = true, skipError = false, abi } = args;
  const publicClient = await getPublicClient();

  const hideSpinner = withSpinner
    ? showSpinner({
        type: 'bouncingBall',
        message: 'Simulating...',
      })
    : () => {};

  try {
    const { walletConnectClient } = await getWalletConnectClient();

    const simulateResult = await publicClient.simulateCalls({
      account: walletConnectClient.account,
      calls,
    });
    simulateCallsErrorHandler(simulateResult, abi);

    hideSpinner();

    return simulateResult;
  } catch (err) {
    hideSpinner();
    await disconnectWalletConnect();

    if (!skipError) printError(err, 'Error when simulating write method');

    throw err;
  }
};

export const callWCWriteMethodWithReceipt = async (args: {
  calls: PopulatedTx[];
  withSpinner?: boolean;
  silent?: boolean;
  skipError?: boolean;
  abi?: Abi;
}) => {
  const {
    calls,
    withSpinner = true,
    silent = false,
    skipError = false,
    abi,
  } = args;

  const { walletConnectClient } = await getWalletConnectClient();

  if (!walletConnectClient || !walletConnectClient.account) {
    throw new Error(
      'No wallet connect client found. Check your wallet and try again.',
    );
  }

  const result = await callWalletConnectSendCalls({
    calls,
    withSpinner,
    silent,
    skipError,
    abi,
  });

  const data = [
    ['Batch calls', calls.length],
    ['Batch ID', result.id],
    result.callStatus ? ['Batch status', result.callStatus.status] : undefined,
    result.txHash ? ['Transaction', result.txHash] : undefined,
    result.receipt ? ['Transaction status', result.receipt.status] : undefined,
    result.receipt
      ? ['Transaction block number', Number(result.receipt.blockNumber)]
      : undefined,
    result.receipt
      ? ['Transaction gas used', Number(result.receipt.gasUsed)]
      : undefined,
  ].filter((d) => d !== undefined);

  !silent &&
    logResult({
      data,
    });

  return result;
};

export const callWCWriteMethodWithReceiptPayloads = async <
  T extends PartialContract,
  M extends keyof T['write'] & string,
>(
  args: BatchTxArgs<T, M>,
) => {
  const {
    contract,
    methodName,
    payloads,
    values,
    withSpinner = true,
    silent = false,
    skipError = false,
  } = args;

  if (!Array.isArray(payloads) || payloads.length === 0) {
    throw new Error('payloads must be a non-empty array');
  }

  const calls = payloads.map((p, i) => ({
    to: contract.address,
    data: encodeFunctionData({
      abi: contract.abi,
      functionName: methodName as any,
      args: p as any,
    }),
    value: values?.[i] ?? 0n,
  }));

  const result = await callWalletConnectSendCalls({
    calls,
    withSpinner,
    silent,
    skipError,
    abi: contract.abi,
  });

  const data = [
    ['Method name', methodName],
    ['Contract', contract.address],
    ['Batch calls', payloads.length],
    ['Batch ID', result.id],
    result.callStatus ? ['Batch status', result.callStatus.status] : undefined,
    result.txHash ? ['Transaction', result.txHash] : undefined,
    result.receipt ? ['Transaction status', result.receipt.status] : undefined,
    result.receipt
      ? ['Transaction block number', Number(result.receipt.blockNumber)]
      : undefined,
    result.receipt
      ? ['Transaction gas used', Number(result.receipt.gasUsed)]
      : undefined,
  ].filter((d) => d !== undefined);

  !silent &&
    logResult({
      data,
    });

  return result;
};

// Helper function to send individual transactions when wallet_sendCalls is not supported
const sendIndividualTransactions = async (args: {
  walletConnectClient: WalletClient;
  isGnosis: boolean;
  calls: PopulatedTx[];
  withSpinner: boolean;
  isBatch: boolean;
}) => {
  const { walletConnectClient, isGnosis, calls, withSpinner, isBatch } = args;
  const publicClient = await getPublicClient();
  const chain = await getChain();

  logInfo('========================================');
  logInfo('FALLBACK: Using individual eth_sendTransaction calls');
  logInfo(`Total transactions to send: ${calls.length}`);
  logInfo(`Chain ID: ${chain.id}`);
  logInfo(`Account: ${walletConnectClient.account?.address}`);
  logInfo(`Is Gnosis Safe: ${isGnosis}`);
  logInfo('========================================');

  const txHashes: Hex[] = [];
  const receipts: any[] = [];

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];

    if (!call) {
      throw new Error(`Transaction ${i + 1} is undefined`);
    }

    const hideSubmitSpinner = withSpinner
      ? showSpinner({
          type: 'bouncingBar',
          message: isBatch
            ? `Submitting transaction ${i + 1}/${calls.length}...`
            : 'Submitting transaction...',
        })
      : () => {};

    try {
      if (!call.to) {
        throw new Error(`Transaction ${i + 1} missing 'to' address`);
      }

      logInfo(`Crafting transaction ${i + 1}/${calls.length}:`);
      logInfo(`  - To: ${call.to}`);
      logInfo(
        `  - Data: ${call.data?.slice(0, 10)}... (${call.data?.length || 0} chars)`,
      );
      logInfo(`  - Value: ${call.value || 0n}`);

      const account = walletConnectClient.account;
      if (!account) throw new Error('WalletConnect account not available');

      const txHash = await walletConnectClient.sendTransaction({
        account: account.address,
        chain,
        to: call.to,
        data: call.data,
        value: call.value,
      });

      hideSubmitSpinner();
      txHashes.push(txHash);

      logInfo(`Transaction ${i + 1}/${calls.length} submitted:`, txHash);

      if (isGnosis) {
        logInfo('Transaction submitted to Gnosis Safe for signing.');
        logInfo(
          'Please sign and execute the transaction in the Gnosis Safe UI.',
        );
        continue; // Don't wait for receipt for Gnosis
      }

      const hideReceiptSpinner = withSpinner
        ? showSpinner({
            type: 'bouncingBar',
            message: isBatch
              ? `Waiting for transaction ${i + 1}/${calls.length} receipt...`
              : 'Waiting for transaction receipt...',
          })
        : () => {};

      const receipt = await waitForTransactionReceipt(publicClient, {
        hash: txHash,
        confirmations: process.env.CONFIRMATIONS
          ? Number(process.env.CONFIRMATIONS)
          : 3,
      });

      hideReceiptSpinner();
      receipts.push(receipt);

      logInfo(
        `Transaction ${i + 1}/${calls.length} confirmed:`,
        receipt.status,
      );

      if (receipt.status === 'reverted') {
        logError(`Transaction ${i + 1}/${calls.length} reverted`);
      }
    } catch (error: any) {
      hideSubmitSpinner();
      logError(`========================================`);
      logError(`Transaction ${i + 1}/${calls.length} FAILED`);
      logError(`Error message: ${error.message}`);
      logError(`Error code: ${error.code || 'N/A'}`);
      if (error.cause) {
        logError(`Error cause: ${JSON.stringify(error.cause)}`);
      }
      logError(`========================================`);
      throw error;
    }
  }

  logInfo('========================================');
  logInfo(`All ${calls.length} transaction(s) completed successfully`);
  logInfo(`Transaction hashes: ${txHashes.join(', ')}`);
  logInfo('========================================');

  if (isGnosis) {
    return {
      id: txHashes[0], // Return first tx hash as ID for Gnosis
    };
  }

  // Return a result compatible with the sendCalls response
  return {
    id: txHashes[0], // Use first tx hash as batch ID
    txHash: txHashes.length === 1 ? txHashes[0] : undefined,
    receipt: receipts.length === 1 ? receipts[0] : undefined,
    callStatus: {
      status: receipts.every((r) => r.status === 'success')
        ? 'success'
        : 'failure',
      receipts,
    },
  };
};

const callWalletConnectSendCalls = async (args: {
  calls: PopulatedTx[];
  withSpinner?: boolean;
  silent?: boolean;
  skipError?: boolean;
  abi?: Abi;
}) => {
  const { calls, withSpinner = true, skipError = false, abi } = args;
  const isBatch = calls.length > 1;

  if (!Array.isArray(calls) || calls.length === 0) {
    throw new Error('calls must be a non-empty array');
  }

  try {
    const { walletConnectClient, isGnosis, supportsWalletSendCalls } =
      await getWalletConnectClient();

    if (!walletConnectClient || !walletConnectClient.account) {
      throw new Error(
        'No wallet connect client found. Check your wallet and try again.',
      );
    }

    await simulateWCWriteTx({
      calls,
      withSpinner,
      skipError,
      abi,
    });

    // Check if wallet supports wallet_sendCalls (EIP-5792)
    if (!supportsWalletSendCalls) {
      logInfo('Wallet does not support wallet_sendCalls (EIP-5792)');
      logInfo('Falling back to individual eth_sendTransaction calls');

      // Fallback to individual transactions
      return await sendIndividualTransactions({
        walletConnectClient,
        isGnosis,
        calls,
        withSpinner,
        isBatch,
      });
    }

    const hideSubmitSpinner = withSpinner
      ? showSpinner({
          type: 'bouncingBar',
          message: isBatch
            ? 'Submitting batch...'
            : 'Submitting transaction...',
        })
      : () => {};

    // DEBUG: Log before attempting sendCalls
    logInfo('Wallet supports wallet_sendCalls - using batch transaction');
    logInfo('Number of calls:', calls.length);

    let result;
    try {
      result = await walletConnectClient.sendCalls({
        account: walletConnectClient.account.address,
        calls,
        experimental_fallback: true, // fallback to legacy sendTransaction if sendCalls is not supported
      });
      logInfo('sendCalls succeeded');
    } catch (error: any) {
      hideSubmitSpinner();
      logError('sendCalls failed with error:', error.message);

      // Check if it's the wallet_sendCalls validation error
      if (
        error.message?.includes('wallet_sendCalls') ||
        error.message?.includes('isValidRequest')
      ) {
        logError('This is a wallet_sendCalls validation error');
        logError('Falling back to individual transactions');

        // Fallback to individual transactions
        return await sendIndividualTransactions({
          walletConnectClient,
          isGnosis,
          calls,
          withSpinner,
          isBatch,
        });
      }

      throw error;
    }

    hideSubmitSpinner();

    if (isGnosis) {
      logInfo('Transaction submitted to Gnosis Safe for signing.');
      logInfo('Please sign and execute the transaction in the Gnosis Safe UI.');
      logInfo(
        'Note: The CLI will not wait for execution completion as signing time is unlimited.',
      );

      return { id: result.id as Hex };
    }

    const hideStatusSpinner = withSpinner
      ? showSpinner({
          type: 'bouncingBar',
          message: isBatch
            ? 'Waiting for batch status...'
            : 'Waiting for transaction status...',
        })
      : () => {};

    const callStatus = await walletConnectClient.waitForCallsStatus({
      id: result.id,
      pollingInterval: PROVIDER_POLLING_INTERVAL,
      timeout: AA_TX_POLLING_TIMEOUT,
    });

    hideStatusSpinner();

    if (callStatus.status === 'failure') {
      logError(
        'Transaction failed. Check your wallet for details.',
        callStatus,
      );

      if (
        callStatus.receipts?.some((receipt) => receipt.status === 'reverted')
      ) {
        logError(
          'Some operation were reverted. Check your wallet for details.',
          callStatus.receipts?.filter(
            (receipt) => receipt.status === 'reverted',
          ),
        );
      }

      throw new Error('Transaction failed. Check your wallet for details.');
    }

    // safe check for reverted operations
    if (callStatus.receipts?.some((receipt) => receipt.status === 'reverted')) {
      throw new Error(
        'Some operation were reverted. Check your wallet for details.',
        {
          cause: callStatus.receipts?.filter(
            (receipt) => receipt.status === 'reverted',
          ),
        },
      );
    }

    // extract last receipt if there was no atomic batch
    const txHash = callStatus.receipts
      ? callStatus?.receipts[callStatus.receipts.length - 1]?.transactionHash
      : undefined;

    if (!txHash) {
      throw new Error(
        'Could not locate TX hash.Check your wallet for details.',
      );
    }

    const hideReceiptSpinner = withSpinner
      ? showSpinner({
          type: 'bouncingBar',
          message: 'Waiting for transaction receipt...',
        })
      : () => {};

    const publicClient = await getPublicClient();
    const receipt = await waitForTransactionReceipt(publicClient, {
      hash: txHash,
      confirmations: process.env.CONFIRMATIONS
        ? Number(process.env.CONFIRMATIONS)
        : 3,
    });

    hideReceiptSpinner();

    return { id: result.id as Hex, callStatus, txHash, receipt };
  } catch (err) {
    await disconnectWalletConnect();

    if (!skipError) printError(err, 'Error when sending batch calls');

    throw err;
  }
};
