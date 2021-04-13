import { TYPES, getBidiCharType, ISOLATE_INIT_TYPES, STRONG_TYPES, NEUTRAL_ISOLATE_TYPES } from './bidiCharTypes.js'
import { closingToOpeningBracket, getCanonicalBracket, openingToClosingBracket } from './bidiBrackets.js'

// Local type aliases
const {
  L: TYPE_L,
  R: TYPE_R,
  EN: TYPE_EN,
  ES: TYPE_ES,
  ET: TYPE_ET,
  AN: TYPE_AN,
  CS: TYPE_CS,
  B: TYPE_B,
  S: TYPE_S,
  WS: TYPE_WS,
  ON: TYPE_ON,
  BN: TYPE_BN,
  NSM: TYPE_NSM,
  AL: TYPE_AL,
  LRO: TYPE_LRO,
  RLO: TYPE_RLO,
  LRE: TYPE_LRE,
  RLE: TYPE_RLE,
  PDF: TYPE_PDF,
  LRI: TYPE_LRI,
  RLI: TYPE_RLI,
  FSI: TYPE_FSI,
  PDI: TYPE_PDI
} = TYPES

export function calculateBidiEmbeddingLevels (str, rootDirection='auto') {
  const MAX_DEPTH = 125

  // Start by mapping all characters to their unicode type, as a bitmask integer
  const charTypes = new Uint32Array(str.length) //consider storing just the bitshift as a uint8?
  for (let i = 0; i < str.length; i++) {
    charTypes[i] = getBidiCharType(str[i])
  }

  const embedLevels = new Uint8Array(str.length)

  const nextEvenLevel = () => stackTop.level + ((stackTop.level & 1) ? 1 : 2)
  const nextOddLevel = () => stackTop.level + ((stackTop.level & 1) ? 2 : 1)

  const isolationPairs = new Map() //init->pdi and pdi->init

  const paragraphs = [] // [{start, end, level}, ...]
  const statusStack = [] // [{level: number, override: L|R|0, isolate: bool}, ...]
  let stackTop
  let overflowIsolateCount
  let overflowEmbeddingCount
  let validIsolateCount
  const FORMATTING_TYPES = TYPE_RLE | TYPE_LRE | TYPE_RLO | TYPE_LRO | ISOLATE_INIT_TYPES | TYPE_PDI | TYPE_PDF | TYPE_B
  for (let i = 0; i < str.length; i++) {
    let charType = charTypes[i] | 0

    // === 3.3.1 The Paragraph Level ===
    if (!statusStack.length) {
      const paraLevel = rootDirection === 'rtl' ? 1 : rootDirection === 'ltr' ? 0 : determineAutoEmbedLevel(i, false)
      paragraphs.push({ start: i, end: str.length - 1, level: paraLevel })

      // 3.3.2 X1
      statusStack.push({
        level: paraLevel,
        override: 0, //0=neutral, 1=L, 2=R
        isolate: 0 //bool
      })
      overflowIsolateCount = 0
      overflowEmbeddingCount = 0
      validIsolateCount = 0
    }

    stackTop = statusStack[statusStack.length - 1] //for convenience

    // === 3.3.2 Explicit Levels and Directions ===

    if (charType & FORMATTING_TYPES) { //prefilter all formatters
      // Explicit Embeddings: 3.3.2 X2 - X3
      if (charType & (TYPE_RLE | TYPE_LRE)) {
        embedLevels[i] = stackTop.level // 5.2
        const level = charType === TYPE_RLE ? nextOddLevel() : nextEvenLevel()
        if (level <= MAX_DEPTH && !overflowIsolateCount && !overflowEmbeddingCount) {
          statusStack.push({
            level,
            override: 0,
            isolate: 0
          })
        } else if (!overflowIsolateCount) {
          overflowEmbeddingCount++
        }
      }

      // Explicit Overrides: 3.3.2 X4 - X5
      else if (charType & (TYPE_RLO | TYPE_LRO)) {
        embedLevels[i] = stackTop.level // 5.2
        const level = charType === TYPE_RLO ? nextOddLevel() : nextEvenLevel()
        if (level <= MAX_DEPTH && !overflowIsolateCount && !overflowEmbeddingCount) {
          statusStack.push({
            level,
            override: (charType & TYPE_RLO) ? TYPE_R : TYPE_L,
            isolate: 0
          })
        } else if (!overflowIsolateCount) {
          overflowEmbeddingCount++
        }
      }

      // Isolates: 3.3.2 X5a - X5c
      else if (charType & ISOLATE_INIT_TYPES) {
        // X5c - FSI becomes either RLI or LRI
        if (charType & TYPE_FSI) {
          charType = determineAutoEmbedLevel(i + 1, true) === 1 ? TYPE_RLI : TYPE_LRI
        }

        embedLevels[i] = stackTop.level
        if (stackTop.override) {
          charTypes[i] = stackTop.override
        }
        const level = (charType & TYPE_RLI) ? nextOddLevel() : nextEvenLevel()
        if (level <= MAX_DEPTH && overflowIsolateCount === 0 && overflowEmbeddingCount === 0) {
          validIsolateCount++
          statusStack.push({
            level,
            override: 0,
            isolate: 1,
            isolInitIndex: i
          })
        } else {
          overflowIsolateCount++
        }
      }

      // Terminating Isolates: 3.3.2 X6a
      else if (charType & TYPE_PDI) {
        if (overflowIsolateCount > 0) {
          overflowIsolateCount--
        } else if (validIsolateCount > 0) {
          overflowEmbeddingCount = 0
          while (!statusStack[statusStack.length - 1].isolate) {
            statusStack.pop()
          }
          // Add to isolation pairs bidirectiona mapping:
          const isolInitIndex = statusStack[statusStack.length - 1].isolInitIndex
          if (isolInitIndex != null) {
            isolationPairs.set(isolInitIndex, i)
            isolationPairs.set(i, isolInitIndex)
          }
          statusStack.pop()
          validIsolateCount--
        }
        stackTop = statusStack[statusStack.length - 1]
        embedLevels[i] = stackTop.level
        if (stackTop.override) {
          charTypes[i] = stackTop.override
        }
      }


      // Terminating Embeddings and Overrides: 3.3.2 X7
      else if (charType & TYPE_PDF) {
        if (overflowIsolateCount === 0) {
          if (overflowEmbeddingCount > 0) {
            overflowEmbeddingCount--
          } else if (!stackTop.isolate && statusStack.length > 1) {
            statusStack.pop()
            stackTop = statusStack[statusStack.length - 1]
          }
        }
        embedLevels[i] = stackTop.level // 5.2
      }

      // End of Paragraph: 3.3.2 X8
      else if (charType & TYPE_B) {
        embedLevels[i] = statusStack[0].level
        paragraphs[paragraphs.length - 1].end = i
      }
    }

    // Non-formatting characters: 3.3.2 X6
    else {
      embedLevels[i] = stackTop.level
      // NOTE: This exclusion of BN seems to go against what section 5.2 says, but is required for test passage
      if (stackTop.override && charType !== TYPE_BN) {
        charTypes[i] = stackTop.override
      }
    }
  }

  // Everything from here on will operate per paragraph.
  paragraphs.forEach(paragraph => {
    // === 3.3.3 Preparations for Implicit Processing ===

    // Remove all RLE, LRE, RLO, LRO, PDF, and BN characters: 3.3.3 X9
    // Note: Due to section 5.2, we won't remove them, but this lets us easily ignore them all as a group from here on
    const BN_LIKE_TYPES = TYPE_BN | TYPE_RLE | TYPE_LRE | TYPE_RLO | TYPE_LRO | TYPE_PDF

    // 3.3.3 X10
    // Compute the set of isolating run sequences as specified by BD13
    const levelRuns = []
    let currentRun = null
    let isolationLevel = 0
    for (let i = paragraph.start; i <= paragraph.end; i++) {
      const lvl = embedLevels[i]
      const charType = charTypes[i] | 0
      const isIsolInit = charType & ISOLATE_INIT_TYPES
      if (charType & BN_LIKE_TYPES) continue
      const isPDI = charType === TYPE_PDI
      if (isIsolInit) {
        isolationLevel++
      }
      if (currentRun && lvl === currentRun.level) {
        currentRun.end = i
        currentRun.endsWithIsolInit = isIsolInit
      } else {
        levelRuns.push(currentRun = {
          start: i,
          end: i,
          level: lvl,
          startsWithPDI: isPDI,
          endsWithIsolInit: isIsolInit
        })
      }
      if (isPDI) {
        isolationLevel--
      }
    }
    // If any level run is composed of only ignored character types, remove it and merge those around it
/*
    for (let r = levelRuns.length; r--;) {
      let hasNonIgnored = false
      for (let i = levelRuns[r].start; i <= levelRuns[r].end; i++) {
        if (!(charTypes[i] & BN_LIKE_TYPES)) {
          hasNonIgnored = true
          break
        }
      }
      if (!hasNonIgnored) {
        if (r > 0 && r < levelRuns.length - 1 && levelRuns[r - 1].level === levelRuns[r + 1].level) {
          levelRuns[r - 1].end = levelRuns[r + 1].end
          levelRuns[r - 1].endsWithIsolInit = levelRuns[r + 1].endsWithIsolInit
          levelRuns.splice(r, 2)
        } else {
          levelRuns.splice(r, 1)
        }
      }
    }
*/
    const isolatingRunSeqs = [] // [{runs: [], sosType: L|R, eosType: L|R}]
    for (let runIdx = 0; runIdx < levelRuns.length; runIdx++) {
      const run = levelRuns[runIdx]
      if (!run.startsWithPDI || (run.startsWithPDI && !isolationPairs.has(run.start))) {
        const seqRuns = [currentRun = run]
        for (let pdiIndex; currentRun && currentRun.endsWithIsolInit && (pdiIndex = isolationPairs.get(currentRun.end)) != null;) {
          for (let i = runIdx + 1; i < levelRuns.length; i++) {
            if (levelRuns[i].start === pdiIndex) {
              seqRuns.push(currentRun = levelRuns[i])
              break
            }
          }
        }
        // build flat list of indices across all runs:
        const seqIndices = []
        for (let i = 0; i < seqRuns.length; i++) {
          const run = seqRuns[i]
          for (let j = run.start; j <= run.end; j++) {
            seqIndices.push(j)
          }
        }
        // determine the sos/eos types:
        let firstLevel = embedLevels[seqIndices[0]]
        let prevLevel = paragraph.level
        for (let i = seqIndices[0] - 1; i >= 0; i--) {
          if (!(charTypes[i] & BN_LIKE_TYPES)) { //5.2
            prevLevel = embedLevels[i]
            break
          }
        }
        const lastIndex = seqIndices[seqIndices.length - 1]
        let lastLevel = embedLevels[lastIndex]
        let nextLevel = paragraph.level
        if (!(charTypes[lastIndex] & ISOLATE_INIT_TYPES)) {
          for (let i = lastIndex + 1; i <= paragraph.end; i++) {
            if (!(charTypes[i] & BN_LIKE_TYPES)) { //5.2
              nextLevel = embedLevels[i]
              break
            }
          }
        }
        isolatingRunSeqs.push({
          seqIndices,
          sosType: Math.max(prevLevel, firstLevel) % 2 ? TYPE_R : TYPE_L,
          eosType: Math.max(nextLevel, lastLevel) % 2 ? TYPE_R : TYPE_L
        })
      }
    }

    // The next steps are done per isolating run sequence
    for (let seqIdx = 0; seqIdx < isolatingRunSeqs.length; seqIdx++) {
      const { seqIndices, sosType, eosType } = isolatingRunSeqs[seqIdx]

      // === 3.3.4 Resolving Weak Types ===

      // W1 + 5.2. Search backward from each NSM to the first character in the isolating run sequence whose
      // bidirectional type is not BN, and set the NSM to ON if it is an isolate initiator or PDI, and to its
      // type otherwise. If the NSM is the first non-BN character, change the NSM to the type of sos.
      for (let si = 0; si < seqIndices.length; si++) {
        const i = seqIndices[si]
        if (charTypes[i] & TYPE_NSM) {
          let prevType = sosType
          for (let sj = si - 1; sj >= 0; sj--) {
            if (!(charTypes[seqIndices[sj]] & BN_LIKE_TYPES)) { //5.2 scan back to first non-BN
              prevType = charTypes[seqIndices[sj]]
              break
            }
          }
          charTypes[i] = (prevType & (ISOLATE_INIT_TYPES | TYPE_PDI)) ? TYPE_ON : prevType
        }
      }

      // W2. Search backward from each instance of a European number until the first strong type (R, L, AL, or sos)
      // is found. If an AL is found, change the type of the European number to Arabic number.
      for (let si = 0; si < seqIndices.length; si++) {
        const i = seqIndices[si]
        if (charTypes[i] & TYPE_EN) {
          for (let sj = si - 1; sj >= -1; sj--) {
            const prevCharType = sj === -1 ? sosType : charTypes[seqIndices[sj]]
            if (prevCharType & STRONG_TYPES) {
              if (prevCharType === TYPE_AL) {
                charTypes[i] = TYPE_AN
              }
              break
            }
          }
        }
      }

      // W3. Change all ALs to R
      for (let si = 0; si < seqIndices.length; si++) {
        const i = seqIndices[si]
        if (charTypes[i] & TYPE_AL) {
          charTypes[i] = TYPE_R
        }
      }

      // W4. A single European separator between two European numbers changes to a European number. A single common
      // separator between two numbers of the same type changes to that type.
      for (let si = 1; si < seqIndices.length - 1; si++) {
        const i = seqIndices[si]
        const type = charTypes[i] | 0
        if (type & (TYPE_ES | TYPE_CS)) {
          let prevType = 0, nextType = 0
          for (let sj = si - 1; sj >= 0; sj--) {
            prevType = charTypes[seqIndices[sj]]
            if (!(prevType & BN_LIKE_TYPES)) { //5.2
              break
            }
          }
          for (let sj = si + 1; sj < seqIndices.length; sj++) {
            nextType = charTypes[seqIndices[sj]]
            if (!(nextType & BN_LIKE_TYPES)) { //5.2
              break
            }
          }
          if (prevType === nextType && (type === TYPE_ES ? prevType === TYPE_EN : (prevType & (TYPE_EN | TYPE_AN)))) {
            charTypes[i] = prevType
          }
        }
      }

      // W5. A sequence of European terminators adjacent to European numbers changes to all European numbers.
      for (let si = 0; si < seqIndices.length; si++) {
        const i = seqIndices[si]
        if (charTypes[i] & TYPE_EN) {
          for (let sj = si - 1; sj >= 0 && (charTypes[seqIndices[sj]] & (TYPE_ET | BN_LIKE_TYPES)); sj--) {
            charTypes[seqIndices[sj]] = TYPE_EN
          }
          for (let sj = si + 1; sj < seqIndices.length && (charTypes[seqIndices[sj]] & (TYPE_ET | BN_LIKE_TYPES)); sj++) {
            charTypes[seqIndices[sj]] = TYPE_EN
          }
        }
      }

      // W6. Otherwise, separators and terminators change to Other Neutral.
      for (let si = 0; si < seqIndices.length; si++) {
        const i = seqIndices[si]
        if (charTypes[i] & (TYPE_ET | TYPE_ES | TYPE_CS)) {
          charTypes[i] = TYPE_ON
          // 5.2 transform adjacent BNs too:
          for (let sj = si - 1; sj >= 0 && (charTypes[seqIndices[sj]] & BN_LIKE_TYPES); sj--) {
            charTypes[seqIndices[sj]] = TYPE_ON
          }
          for (let sj = si + 1; sj < seqIndices.length && (charTypes[seqIndices[sj]] & BN_LIKE_TYPES); sj++) {
            charTypes[seqIndices[sj]] = TYPE_ON
          }
        }
      }

      // W7. Search backward from each instance of a European number until the first strong type (R, L, or sos)
      // is found. If an L is found, then change the type of the European number to L.
      // NOTE: implemented in single forward pass for efficiency
      for (let si = 0, prevStrongType = sosType; si < seqIndices.length; si++) {
        const i = seqIndices[si]
        const type = charTypes[i]
        if (type & TYPE_EN) {
          if (prevStrongType === TYPE_L) {
            charTypes[i] = TYPE_L
          }
        } else if (type & STRONG_TYPES) {
          prevStrongType = type
        }
      }

      // === 3.3.5 Resolving Neutral and Isolate Formatting Types ===

      // N0. Process bracket pairs in an isolating run sequence sequentially in the logical order of the text
      // positions of the opening paired brackets using the logic given below. Within this scope, bidirectional
      // types EN and AN are treated as R.
      const R_TYPES_FOR_N_STEPS = (TYPE_R | TYPE_EN | TYPE_AN)
      const STRONG_TYPES_FOR_N_STEPS = R_TYPES_FOR_N_STEPS | TYPE_L

      // * Identify the bracket pairs in the current isolating run sequence according to BD16.
      const bracketPairs = []
      {
        const openerStack = []
        for (let si = 0; si < seqIndices.length; si++) {
          // NOTE: for any potential bracket character we also test that it still carries a NI
          // type, as that may have been changed earlier. This doesn't seem to be explicitly
          // called out in the spec, but is required for passage of certain tests.
          if (charTypes[seqIndices[si]] & NEUTRAL_ISOLATE_TYPES) {
            const char = str[seqIndices[si]]
            let oppositeBracket
            // Opening bracket
            if (openingToClosingBracket(char) !== null) {
              if (openerStack.length < 63) {
                openerStack.push({char, seqIndex: si})
              } else {
                break
              }
            }
            // Closing bracket
            else if ((oppositeBracket = closingToOpeningBracket(char)) !== null) {
              for (let stackIdx = openerStack.length - 1; stackIdx >= 0; stackIdx--) {
                const stackChar = openerStack[stackIdx].char
                if (stackChar === oppositeBracket ||
                  stackChar === closingToOpeningBracket(getCanonicalBracket(char)) ||
                  openingToClosingBracket(getCanonicalBracket(stackChar)) === char
                ) {
                  bracketPairs.push([openerStack[stackIdx].seqIndex, si])
                  openerStack.length = stackIdx //pop the matching bracket and all following
                  break
                }
              }
            }
          }
        }
        bracketPairs.sort((a, b) => a[0] - b[0])
      }
      // * For each bracket-pair element in the list of pairs of text positions
      for (let pairIdx = 0; pairIdx < bracketPairs.length; pairIdx++) {
        const [openSeqIdx, closeSeqIdx] = bracketPairs[pairIdx]
        // a. Inspect the bidirectional types of the characters enclosed within the bracket pair.
        // b. If any strong type (either L or R) matching the embedding direction is found, set the type for both
        // brackets in the pair to match the embedding direction.
        let foundStrongType = false
        let useStrongType = 0
        for (let si = openSeqIdx + 1; si < closeSeqIdx; si++) {
          const i = seqIndices[si]
          if (charTypes[i] & STRONG_TYPES_FOR_N_STEPS) {
            foundStrongType = true
            const lr = (charTypes[i] & R_TYPES_FOR_N_STEPS) ? TYPE_R : TYPE_L
            if (lr === getEmbedDirection(i)) {
              useStrongType = lr
              break
            }
          }
        }
        // c. Otherwise, if there is a strong type it must be opposite the embedding direction. Therefore, test
        // for an established context with a preceding strong type by checking backwards before the opening paired
        // bracket until the first strong type (L, R, or sos) is found.
        //    1. If the preceding strong type is also opposite the embedding direction, context is established, so
        //    set the type for both brackets in the pair to that direction.
        //    2. Otherwise set the type for both brackets in the pair to the embedding direction.
        if (foundStrongType && !useStrongType) {
          useStrongType = sosType
          for (let si = openSeqIdx - 1; si >= 0; si--) {
            const i = seqIndices[si]
            if (charTypes[i] & STRONG_TYPES_FOR_N_STEPS) {
              const lr = (charTypes[i] & R_TYPES_FOR_N_STEPS) ? TYPE_R : TYPE_L
              if (lr !== getEmbedDirection(i)) {
                useStrongType = lr
              } else {
                useStrongType = getEmbedDirection(i)
              }
              break
            }
          }
        }
        if (useStrongType) {
          charTypes[seqIndices[openSeqIdx]] = charTypes[seqIndices[closeSeqIdx]] = useStrongType
          // * Any number of characters that had original bidirectional character type NSM prior to the application
          // of W1 that immediately follow a paired bracket which changed to L or R under N0 should change to match
          // the type of their preceding bracket.
          if (useStrongType !== getEmbedDirection(seqIndices[openSeqIdx])) {
            for (let si = openSeqIdx + 1; si < seqIndices.length; si++) {
              if (!(charTypes[seqIndices[si]] & BN_LIKE_TYPES)) {
                if (getBidiCharType(str[seqIndices[si]]) & TYPE_NSM) {
                  charTypes[seqIndices[si]] = useStrongType
                }
                break
              }
            }
          }
          if (useStrongType !== getEmbedDirection(seqIndices[closeSeqIdx])) {
            for (let si = closeSeqIdx + 1; si < seqIndices.length; si++) {
              if (!(charTypes[seqIndices[si]] & BN_LIKE_TYPES)) {
                if (getBidiCharType(str[seqIndices[si]]) & TYPE_NSM) {
                  charTypes[seqIndices[si]] = useStrongType
                }
                break
              }
            }
          }
        }
      }

      // N1. A sequence of NIs takes the direction of the surrounding strong text if the text on both sides has the
      // same direction.
      // N2. Any remaining NIs take the embedding direction.
      for (let si = 0; si < seqIndices.length; si++) {
        if (charTypes[seqIndices[si]] & NEUTRAL_ISOLATE_TYPES) {
          let niRunStart = si, niRunEnd = si
          let prevType = sosType //si === 0 ? sosType : (charTypes[seqIndices[si - 1]] & R_TYPES_FOR_N_STEPS) ? TYPE_R : TYPE_L
          for (let si2 = si - 1; si2 >= 0; si2--) {
            if (charTypes[seqIndices[si2]] & BN_LIKE_TYPES) {
              niRunStart = si2 //5.2 treat BNs adjacent to NIs as NIs
            } else {
              prevType = (charTypes[seqIndices[si2]] & R_TYPES_FOR_N_STEPS) ? TYPE_R : TYPE_L
              break
            }
          }
          let nextType = eosType
          for (let si2 = si + 1; si2 < seqIndices.length; si2++) {
            if (charTypes[seqIndices[si2]] & (NEUTRAL_ISOLATE_TYPES | BN_LIKE_TYPES)) {
              niRunEnd = si2
            } else {
              nextType = (charTypes[seqIndices[si2]] & R_TYPES_FOR_N_STEPS) ? TYPE_R : TYPE_L
              break
            }
          }
          for (let sj = niRunStart; sj <= niRunEnd; sj++) {
            charTypes[seqIndices[sj]] = prevType === nextType ? prevType : getEmbedDirection(seqIndices[sj])
          }
          si = niRunEnd
        }
      }
    }


    // === 3.3.6 Resolving Implicit Levels ===

    for (let i = paragraph.start; i <= paragraph.end; i++) {
      const level = embedLevels[i] | 0
      const type = charTypes[i] | 0
      // I2. For all characters with an odd (right-to-left) embedding level, those of type L, EN or AN go up one level.
      if (level & 1) {
        if (type & (TYPE_L | TYPE_EN | TYPE_AN)) {
          embedLevels[i]++
        }
      }
      // I1. For all characters with an even (left-to-right) embedding level, those of type R go up one level
      // and those of type AN or EN go up two levels.
      else {
        if (type & TYPE_R) {
          embedLevels[i]++
        }
        else if (type & (TYPE_AN | TYPE_EN)) {
          embedLevels[i] += 2
        }
      }

      // 5.2: Resolve any LRE, RLE, LRO, RLO, PDF, or BN to the level of the preceding character if there is one,
      // and otherwise to the base level.
      if (type & BN_LIKE_TYPES) {
        embedLevels[i] = i === 0 ? paragraph.level : embedLevels[i - 1]
      }

      // 3.4 L1: Reset the embedding level of certain characters (based on original type) to the paragraph embedding level
      // NOTE: this will also need to be done per line *after* wrapping occurs
      if (i === paragraph.end || (getBidiCharType(str[i]) & (TYPE_S | TYPE_B))) {
        for (let i2 = i; i2 >= 0; i2--) {
          if (getBidiCharType(str[i2]) & (TYPE_S | TYPE_WS | TYPE_B | ISOLATE_INIT_TYPES | TYPE_PDI | BN_LIKE_TYPES)) {
            embedLevels[i2] = paragraph.level
          } else {
            break
          }
        }
      }
    }
  })

  // DONE! The resolved levels can then be used, after line wrapping, to flip runs of characters
  // according to section 3.4 Reordering Resolved Levels
  return embedLevels



  function determineAutoEmbedLevel (start, isFSI) {
    // 3.3.1 P2 - P3
    for (let i = start; i < str.length; i++) {
      const charType = charTypes[i] | 0
      if (charType & (TYPE_R | TYPE_AL)) {
        return 1
      }
      if ((charType & (TYPE_B | TYPE_L)) || (isFSI && charType === TYPE_PDI)) {
        return 0
      }
      if (charType & ISOLATE_INIT_TYPES) {
        const pdi = indexOfMatchingPDI(i)
        i = pdi === -1 ? str.length : pdi
      }
    }
    return 0
  }

  function indexOfMatchingPDI (isolateStart) {
    // 3.1.2 BD9
    let isolationLevel = 1
    for (let i = isolateStart + 1; i < str.length; i++) {
      const charType = charTypes[i] | 0
      if (charType & TYPE_B) {
        break
      }
      if (charType & TYPE_PDI) {
        if (--isolationLevel === 0) {
          return i
        }
      } else if (charType & ISOLATE_INIT_TYPES) {
        isolationLevel++
      }
    }
    return -1
  }

  function getEmbedDirection(i) {
    return (embedLevels[i] & 1) ? TYPE_R : TYPE_L
  }

}
