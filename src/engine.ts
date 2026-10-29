import { formatEther, type PublicClient } from "viem";
import type { Config } from "./config.js";
import { FeeOracle } from "./fees.js";
import { Session } from "./session.js";
import type { State } from "./state.js";
import { makeWakeSource } from "./rpc.js";
import { Watcher } from "./watcher.js";
import type { Wallet } from "./wallets.js";

/**
 * Single-owner setup used by `npm start`: one Watcher feeding one Session.
 * The Telegram bot wires many Sessions to one Watcher (see src/tg/hub.ts).
 */
export class Engine {
  readonly watcher: Watcher;
  readonly session: Session;

  constructor(publicClient: PublicClient, wallets: Wallet[], private cfg: Config, private state: State, watchClient?: PublicClient) {
    const feeOracle = new FeeOracle(publicClient, {
      multiplier: cfg.baseFeeMultiplier,
      minPriorityFeeWei: cfg.priorityFeeWei,
      useSuggestedTip: cfg.useSuggestedTip,
    });
    this.session = new Session({ publicClient, feeOracle, state, config: () => cfg, wallets: () => wallets });
    this.watcher = new Watcher(watchClient ?? publicClient, {
      actionClient: publicClient,
      windowBlocks: cfg.windowBlocks,
      backfillBlocks: cfg.backfillBlocks,
      liveFeed: cfg.liveFeed,
      seaDrop: cfg.drops ? cfg.seaDropAddress : undefined,
      onWake: makeWakeSource(cfg),
      pollIntervalMs: cfg.pollIntervalMs,
      vet: { explorerApi: cfg.explorerApi, requireVerified: cfg.requireVerified, trace: cfg.vetTrace },
      heartbeatExtra: () => {
        const s = this.session.stats;
        return (
          `in-flight ${this.session.busy} | minted ${s.minted} failed ${s.failed} dry-run ${s.dryRun} | ` +
          `gas spent ${formatEther(this.state.gasSpent())}/${formatEther(this.cfg.totalGasBudgetWei)} ETH`
        );
      },
    });
    this.watcher.subscribe(this.session);
  }

  get detector() {
    return this.watcher.detector;
  }

  init(): Promise<void> {
    return this.watcher.init();
  }

  run(): Promise<void> {
    return this.watcher.run();
  }

  tick(): Promise<void> {
    return this.watcher.tick();
  }

  stop(): void {
    this.watcher.stop();
    this.session.stop();
  }

  drain(): Promise<void> {
    return this.session.drain();
  }
}
