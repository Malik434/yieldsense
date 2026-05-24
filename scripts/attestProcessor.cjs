/**
 * Backward-compatible wrapper around scripts/rotateProcessor.cjs.
 *
 * The protocol now authorizes Acurast deployment addresses through
 * ExecutorRegistry roles instead of ownerAttestProcessor on YieldSenseKeeper.
 */

"use strict";

require("./rotateProcessor.cjs");
