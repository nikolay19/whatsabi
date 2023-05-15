"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.disasm = exports.abiFromBytecode = exports.BytecodeIter = void 0;
const ethers_1 = require("ethers");
const opcodes_1 = require("./opcodes");
function valueToOffset(value) {
    // FIXME: Should be a cleaner way to do this...
    return parseInt(ethers_1.ethers.utils.hexlify(value), 16);
}
// BytecodeIter takes EVM bytecode and handles iterating over it with correct
// step widths, while tracking N buffer of previous offsets for indexed access.
// This is useful for checking against sequences of variable width
// instructions.
class BytecodeIter {
    bytecode;
    nextStep; // Instruction count
    nextPos; // Byte-wise instruction position (takes variable width into account)
    // TODO: Could improve the buffer by making it sparse tracking of only
    // variable-width (PUSH) instruction indices, this would allow relatively
    // efficient seeking to arbitrary positions after a full iter. Then again,
    // roughly 1/4 of instructions are PUSH, so maybe it doesn't help enough?
    posBuffer; // Buffer of positions
    posBufferSize;
    constructor(bytecode, config) {
        this.nextStep = 0;
        this.nextPos = 0;
        if (config === undefined)
            config = {};
        this.posBufferSize = Math.max(config.bufferSize || 1, 1);
        this.posBuffer = [];
        this.bytecode = ethers_1.ethers.utils.arrayify(bytecode, { allowMissingPrefix: true });
    }
    hasMore() {
        return (this.bytecode.length > this.nextPos);
    }
    next() {
        if (this.bytecode.length <= this.nextPos)
            return opcodes_1.opcodes.STOP;
        const instruction = this.bytecode[this.nextPos];
        const width = (0, opcodes_1.pushWidth)(instruction);
        // TODO: Optimization: Could use a circular buffer
        if (this.posBuffer.length >= this.posBufferSize)
            this.posBuffer.shift();
        this.posBuffer.push(this.nextPos);
        this.nextStep += 1;
        this.nextPos += 1 + width;
        return instruction;
    }
    // step is the current instruction position that we've iterated over. If
    // iteration has not begun, then it's -1.
    step() {
        return this.nextStep - 1;
    }
    // pos is the byte offset of the current instruction we've iterated over.
    // If iteration has not begun then it's -1.
    pos() {
        if (this.posBuffer.length === 0)
            return -1;
        return this.posBuffer[this.posBuffer.length - 1];
    }
    // asPos returns an absolute position for a given position that could be relative.
    asPos(posOrRelativeStep) {
        let pos = posOrRelativeStep;
        if (pos < 0) {
            pos = this.posBuffer[this.posBuffer.length + pos];
            if (pos === undefined) {
                throw new Error("buffer does not contain relative step");
            }
        }
        return pos;
    }
    // at returns instruction at an absolute byte position or relative negative
    // buffered step offset. Buffered step offsets must be negative and start
    // at -1 (current step).
    at(posOrRelativeStep) {
        const pos = this.asPos(posOrRelativeStep);
        return this.bytecode[pos];
    }
    // value of last next-returned OpCode (should be a PUSHN intruction)
    value() {
        return this.valueAt(-1);
    }
    // valueAt returns the variable width value for PUSH-like instructions (or
    // empty value otherwise), at pos pos can be a relative negative count for
    // relative buffered offset.
    valueAt(posOrRelativeStep) {
        const pos = this.asPos(posOrRelativeStep);
        const instruction = this.bytecode[pos];
        const width = (0, opcodes_1.pushWidth)(instruction);
        return this.bytecode.slice(pos + 1, pos + 1 + width);
    }
}
exports.BytecodeIter = BytecodeIter;
// Opcodes that tell us something interesting about the function they're in
const interestingOpCodes = new Set([
    opcodes_1.opcodes.STOP,
    opcodes_1.opcodes.RETURN,
    opcodes_1.opcodes.CALLDATALOAD,
    opcodes_1.opcodes.CALLDATASIZE,
    opcodes_1.opcodes.CALLDATACOPY,
    opcodes_1.opcodes.SLOAD,
    opcodes_1.opcodes.SSTORE,
    opcodes_1.opcodes.REVERT,
    // TODO: Add LOGs to track event emitters?
]);
function abiFromBytecode(bytecode) {
    const p = disasm(bytecode);
    const abi = [];
    for (const [selector, offset] of Object.entries(p.selectors)) {
        // TODO: Optimization: If we only look at selectors in the jump table region, we shouldn't need to check JUMPDEST validity.
        if (!(offset in p.dests)) {
            // Selector does not point to a valid jumpdest. This should not happen.
            continue;
        }
        // Collapse tags for function call graph
        const fn = p.dests[offset];
        const tags = subtreeTags(fn, p.dests);
        const funcABI = {
            type: "function",
            selector: selector,
            payable: !p.notPayable[offset],
        };
        // Note that these are not very reliable because our tag detection
        // fails to follow dynamic jumps.
        let mutability = "nonpayable";
        if (funcABI.payable) {
            mutability = "payable";
        }
        else if (!tags.has(opcodes_1.opcodes.SSTORE)) {
            mutability = "view";
        }
        // TODO: Can we make a claim about purity? Probably not reliably without handling dynamic jumps?
        // if (mutability === "view" && !tags.has(opcodes.SLOAD)) {
        //    mutability = "pure";
        // }
        funcABI.stateMutability = mutability;
        // Unfortunately we don't have better details about the type sizes, so we just return a dynamically-sized /shrug
        if (tags.has(opcodes_1.opcodes.RETURN) || mutability === "view") {
            // FIXME: We assume outputs based on mutability, that's a hack.
            funcABI.outputs = [{ type: "bytes" }];
        }
        if (tags.has(opcodes_1.opcodes.CALLDATALOAD) || tags.has(opcodes_1.opcodes.CALLDATASIZE) || tags.has(opcodes_1.opcodes.CALLDATACOPY)) {
            funcABI.inputs = [{ type: "bytes" }];
        }
        abi.push(funcABI);
    }
    for (const h of p.eventCandidates) {
        abi.push({
            type: "event",
            hash: h,
        });
    }
    return abi;
}
exports.abiFromBytecode = abiFromBytecode;
const _EmptyArray = new Uint8Array();
function disasm(bytecode) {
    //console.log("DISASM LIB VERSION 1");
    const p = {
        dests: {},
        selectors: {},
        notPayable: {},
        eventCandidates: [],
    };
    const selectorDests = new Set();
    let lastPush32 = _EmptyArray; // Track last push32 to find log topics
    let checkJumpTable = true;
    let resumeJumpTable = new Set();
    let currentFunction = {
        byteOffset: 0,
        start: 0,
        opTags: new Set(),
        jumps: new Array(),
    };
    p.dests[0] = currentFunction;
    const code = new BytecodeIter(bytecode, { bufferSize: 5 });
    while (code.hasMore()) {
        const inst = code.next();
        const pos = code.pos();
        const step = code.step();
        // Track last PUSH32 to find LOG topics
        // This is probably not bullet proof but seems like a good starting point
        if (inst === opcodes_1.opcodes.PUSH32) {
            lastPush32 = code.value();
            continue;
        }
        else if ((0, opcodes_1.isLog)(inst) && lastPush32.length > 0) {
            p.eventCandidates.push(ethers_1.ethers.utils.hexlify(lastPush32));
            continue;
        }
        // Find JUMPDEST labels
        if (inst === opcodes_1.opcodes.JUMPDEST) {
            // End of the function, or disjoint function?
            if ((0, opcodes_1.isHalt)(code.at(-2)) || code.at(-2) === opcodes_1.opcodes.JUMP) {
                if (currentFunction)
                    currentFunction.end = pos - 1;
                currentFunction = {
                    byteOffset: step,
                    start: pos,
                    opTags: new Set(),
                    jumps: new Array(),
                };
                // We don't stop looking for jump tables until we find at least one selector
                if (checkJumpTable && Object.keys(p.selectors).length > 0) {
                    checkJumpTable = false;
                }
                if (resumeJumpTable.delete(pos)) {
                    // Continuation of a previous jump table?
                    // Selector branch trees start by pushing CALLDATALOAD or it was pushed before.
                    checkJumpTable = code.at(pos + 1) === opcodes_1.opcodes.DUP1 || code.at(pos + 1) === opcodes_1.opcodes.CALLDATALOAD;
                }
            } // Otherwise it's just a simple branch, we continue
            // Index jump destinations so we can check against them later
            p.dests[pos] = currentFunction;
            // Check whether a JUMPDEST has non-payable guards
            //
            // We look for a sequence of instructions that look like:
            // JUMPDEST CALLVALUE DUP1 ISZERO
            //
            // We can do direct positive indexing because we know that there
            // are no variable-width instructions in our sequence.
            if (code.at(pos + 1) === opcodes_1.opcodes.CALLVALUE &&
                code.at(pos + 2) === opcodes_1.opcodes.DUP1 &&
                code.at(pos + 3) === opcodes_1.opcodes.ISZERO) {
                p.notPayable[pos] = step;
                // TODO: Optimization: Could seek ahead 3 pos/count safely
            }
            // TODO: Check whether function has a simple return flow?
            // if (code.at(pos - 1) === opcodes.RETURN) { ... }
            continue;
        }
        // Annotate current function
        if (currentFunction.opTags !== undefined) {
            // Detect simple JUMP/JUMPI helper subroutines
            if ((inst === opcodes_1.opcodes.JUMP || inst === opcodes_1.opcodes.JUMPI) && (0, opcodes_1.isPush)(code.at(-2))) {
                const jumpOffset = valueToOffset(code.valueAt(-2));
                currentFunction.jumps.push(jumpOffset);
            }
            // Tag current function with interesting opcodes (not including above)
            if (interestingOpCodes.has(inst)) {
                currentFunction.opTags.add(inst);
            }
        }
        if (!checkJumpTable)
            continue; // Skip searching for function selectors at this point
        // We're in a jump table section now. Let's find some selectors.
        if (inst === opcodes_1.opcodes.JUMP && (0, opcodes_1.isPush)(code.at(-2))) {
            // The table is continued elsewhere? Or could be a default target
            const offsetDest = valueToOffset(code.valueAt(-2));
            resumeJumpTable.add(offsetDest);
        }
        // Beyond this, we're only looking with instruction sequences that end with 
        //   ... PUSHN <BYTEN> JUMPI
        if (!(code.at(-1) === opcodes_1.opcodes.JUMPI && (0, opcodes_1.isPush)(code.at(-2))))
            continue;
        const offsetDest = valueToOffset(code.valueAt(-2));
        currentFunction.jumps.push(offsetDest);
        // Find callable function selectors:
        //
        // https://github.com/ethereum/solidity/blob/242096695fd3e08cc3ca3f0a7d2e06d09b5277bf/libsolidity/codegen/ContractCompiler.cpp#L333
        //
        // We're looking for a sequence of opcodes that looks like:
        //
        //    DUP1 PUSH4 0x2E64CEC1 EQ PUSH1 0x37    JUMPI
        //    DUP1 PUSH4 <SELECTOR> EQ PUSHN <OFFSET> JUMPI
        //    80   63    ^          14 60-7f ^       57
        //               Selector            Dest
        //
        // We can reliably skip checking for DUP1 if we're only searching
        // within `inJumpTable` range.
        //
        // Note that sizes of selectors and destinations can vary. Selector
        // PUSH can get optimized with zero-prefixes, all the way down to an
        // ISZERO routine (see next condition block).
        
        if (code.at(-3) === opcodes_1.opcodes.EQ &&
            (0, opcodes_1.isPush)(code.at(-4))) {
            // Found a function selector sequence, save it to check against JUMPDEST table later
            let value = code.valueAt(-4);
            if (value.length < 4) {
                // 0-prefixed comparisons get optimized to a smaller width than PUSH4
                // FIXME: Could just use ethers.utils.hexzeropad
                value = ethers_1.ethers.utils.zeroPad(value, 4);
            }
            const selector = ethers_1.ethers.utils.hexlify(value);
            p.selectors[selector] = offsetDest;
            selectorDests.add(offsetDest);
            continue;
        }
        // Sometimes the positions get swapped with DUP2:
        //    PUSHN <SELECTOR> DUP2 EQ PUSHN <OFFSET> JUMPI
        if (code.at(-3) === opcodes_1.opcodes.EQ &&
            code.at(-4) === opcodes_1.opcodes.DUP2 &&
            (0, opcodes_1.isPush)(code.at(-5))) {
            // Found a function selector sequence, save it to check against JUMPDEST table later
            let value = code.valueAt(-5);
            if (value.length < 4) {
                // 0-prefixed comparisons get optimized to a smaller width than PUSH4
                value = ethers_1.ethers.utils.zeroPad(value, 4);
            }
            const selector = ethers_1.ethers.utils.hexlify(value);
            p.selectors[selector] = offsetDest;
            selectorDests.add(offsetDest);
            continue;
        }
        
        // In some cases, the sequence can get optimized such as for 0x00000000:
        //    DUP1 ISZERO PUSHN <OFFSET> JUMPI
        /*if (code.at(-3) === opcodes_1.opcodes.ISZERO &&
            code.at(-4) === opcodes_1.opcodes.DUP1) {
            const selector = "0x00000000";
            p.selectors[selector] = offsetDest;
            selectorDests.add(offsetDest);
            continue;
        }*/
        // Jumptable trees use GT/LT comparisons to branch jumps.
        //    DUP1 PUSHN <SELECTOR> GT/LT PUSHN <OFFSET> JUMPI
        if (code.at(-3) !== opcodes_1.opcodes.EQ &&
            (0, opcodes_1.isCompare)(code.at(-3)) &&
            code.at(-5) === opcodes_1.opcodes.DUP1) {
            resumeJumpTable.add(offsetDest);
            continue;
        }
    }
    return p;
}
exports.disasm = disasm;
function subtreeTags(entryFunc, dests) {
    let tags = new Set([]);
    const stack = new Array(entryFunc);
    const seen = new Set();
    while (stack.length > 0) {
        const fn = stack.pop();
        if (!fn)
            continue;
        if (seen.has(fn.start))
            continue;
        seen.add(fn.start);
        tags = new Set([...tags, ...fn.opTags]);
        stack.push(...fn.jumps.map(offset => dests[offset]));
    }
    return tags;
}
//# sourceMappingURL=disasm.js.map
