#!/usr/bin/env node
import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true
      });
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// ../node_modules/commander/lib/error.js
var require_error = __commonJS((exports) => {
  class CommanderError extends Error {
    constructor(exitCode, code, message) {
      super(message);
      Error.captureStackTrace(this, this.constructor);
      this.name = this.constructor.name;
      this.code = code;
      this.exitCode = exitCode;
      this.nestedError = undefined;
    }
  }

  class InvalidArgumentError extends CommanderError {
    constructor(message) {
      super(1, "commander.invalidArgument", message);
      Error.captureStackTrace(this, this.constructor);
      this.name = this.constructor.name;
    }
  }
  exports.CommanderError = CommanderError;
  exports.InvalidArgumentError = InvalidArgumentError;
});

// ../node_modules/commander/lib/argument.js
var require_argument = __commonJS((exports) => {
  var { InvalidArgumentError } = require_error();

  class Argument {
    constructor(name, description) {
      this.description = description || "";
      this.variadic = false;
      this.parseArg = undefined;
      this.defaultValue = undefined;
      this.defaultValueDescription = undefined;
      this.argChoices = undefined;
      switch (name[0]) {
        case "<":
          this.required = true;
          this._name = name.slice(1, -1);
          break;
        case "[":
          this.required = false;
          this._name = name.slice(1, -1);
          break;
        default:
          this.required = true;
          this._name = name;
          break;
      }
      if (this._name.endsWith("...")) {
        this.variadic = true;
        this._name = this._name.slice(0, -3);
      }
    }
    name() {
      return this._name;
    }
    _collectValue(value, previous) {
      if (previous === this.defaultValue || !Array.isArray(previous)) {
        return [value];
      }
      previous.push(value);
      return previous;
    }
    default(value, description) {
      this.defaultValue = value;
      this.defaultValueDescription = description;
      return this;
    }
    argParser(fn) {
      this.parseArg = fn;
      return this;
    }
    choices(values) {
      this.argChoices = values.slice();
      this.parseArg = (arg, previous) => {
        if (!this.argChoices.includes(arg)) {
          throw new InvalidArgumentError(`Allowed choices are ${this.argChoices.join(", ")}.`);
        }
        if (this.variadic) {
          return this._collectValue(arg, previous);
        }
        return arg;
      };
      return this;
    }
    argRequired() {
      this.required = true;
      return this;
    }
    argOptional() {
      this.required = false;
      return this;
    }
  }
  function humanReadableArgName(arg) {
    const nameOutput = arg.name() + (arg.variadic === true ? "..." : "");
    return arg.required ? "<" + nameOutput + ">" : "[" + nameOutput + "]";
  }
  exports.Argument = Argument;
  exports.humanReadableArgName = humanReadableArgName;
});

// ../node_modules/commander/lib/help.js
var require_help = __commonJS((exports) => {
  var { humanReadableArgName } = require_argument();

  class Help {
    constructor() {
      this.helpWidth = undefined;
      this.minWidthToWrap = 40;
      this.sortSubcommands = false;
      this.sortOptions = false;
      this.showGlobalOptions = false;
    }
    prepareContext(contextOptions) {
      this.helpWidth = this.helpWidth ?? contextOptions.helpWidth ?? 80;
    }
    visibleCommands(cmd) {
      const visibleCommands = cmd.commands.filter((cmd2) => !cmd2._hidden);
      const helpCommand = cmd._getHelpCommand();
      if (helpCommand && !helpCommand._hidden) {
        visibleCommands.push(helpCommand);
      }
      if (this.sortSubcommands) {
        visibleCommands.sort((a, b) => {
          return a.name().localeCompare(b.name());
        });
      }
      return visibleCommands;
    }
    compareOptions(a, b) {
      const getSortKey = (option) => {
        return option.short ? option.short.replace(/^-/, "") : option.long.replace(/^--/, "");
      };
      return getSortKey(a).localeCompare(getSortKey(b));
    }
    visibleOptions(cmd) {
      const visibleOptions = cmd.options.filter((option) => !option.hidden);
      const helpOption = cmd._getHelpOption();
      if (helpOption && !helpOption.hidden) {
        const removeShort = helpOption.short && cmd._findOption(helpOption.short);
        const removeLong = helpOption.long && cmd._findOption(helpOption.long);
        if (!removeShort && !removeLong) {
          visibleOptions.push(helpOption);
        } else if (helpOption.long && !removeLong) {
          visibleOptions.push(cmd.createOption(helpOption.long, helpOption.description));
        } else if (helpOption.short && !removeShort) {
          visibleOptions.push(cmd.createOption(helpOption.short, helpOption.description));
        }
      }
      if (this.sortOptions) {
        visibleOptions.sort(this.compareOptions);
      }
      return visibleOptions;
    }
    visibleGlobalOptions(cmd) {
      if (!this.showGlobalOptions)
        return [];
      const globalOptions = [];
      for (let ancestorCmd = cmd.parent;ancestorCmd; ancestorCmd = ancestorCmd.parent) {
        const visibleOptions = ancestorCmd.options.filter((option) => !option.hidden);
        globalOptions.push(...visibleOptions);
      }
      if (this.sortOptions) {
        globalOptions.sort(this.compareOptions);
      }
      return globalOptions;
    }
    visibleArguments(cmd) {
      if (cmd._argsDescription) {
        cmd.registeredArguments.forEach((argument) => {
          argument.description = argument.description || cmd._argsDescription[argument.name()] || "";
        });
      }
      if (cmd.registeredArguments.find((argument) => argument.description)) {
        return cmd.registeredArguments;
      }
      return [];
    }
    subcommandTerm(cmd) {
      const args = cmd.registeredArguments.map((arg) => humanReadableArgName(arg)).join(" ");
      return cmd._name + (cmd._aliases[0] ? "|" + cmd._aliases[0] : "") + (cmd.options.length ? " [options]" : "") + (args ? " " + args : "");
    }
    optionTerm(option) {
      return option.flags;
    }
    argumentTerm(argument) {
      return argument.name();
    }
    longestSubcommandTermLength(cmd, helper) {
      return helper.visibleCommands(cmd).reduce((max, command) => {
        return Math.max(max, this.displayWidth(helper.styleSubcommandTerm(helper.subcommandTerm(command))));
      }, 0);
    }
    longestOptionTermLength(cmd, helper) {
      return helper.visibleOptions(cmd).reduce((max, option) => {
        return Math.max(max, this.displayWidth(helper.styleOptionTerm(helper.optionTerm(option))));
      }, 0);
    }
    longestGlobalOptionTermLength(cmd, helper) {
      return helper.visibleGlobalOptions(cmd).reduce((max, option) => {
        return Math.max(max, this.displayWidth(helper.styleOptionTerm(helper.optionTerm(option))));
      }, 0);
    }
    longestArgumentTermLength(cmd, helper) {
      return helper.visibleArguments(cmd).reduce((max, argument) => {
        return Math.max(max, this.displayWidth(helper.styleArgumentTerm(helper.argumentTerm(argument))));
      }, 0);
    }
    commandUsage(cmd) {
      let cmdName = cmd._name;
      if (cmd._aliases[0]) {
        cmdName = cmdName + "|" + cmd._aliases[0];
      }
      let ancestorCmdNames = "";
      for (let ancestorCmd = cmd.parent;ancestorCmd; ancestorCmd = ancestorCmd.parent) {
        ancestorCmdNames = ancestorCmd.name() + " " + ancestorCmdNames;
      }
      return ancestorCmdNames + cmdName + " " + cmd.usage();
    }
    commandDescription(cmd) {
      return cmd.description();
    }
    subcommandDescription(cmd) {
      return cmd.summary() || cmd.description();
    }
    optionDescription(option) {
      const extraInfo = [];
      if (option.argChoices) {
        extraInfo.push(`choices: ${option.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`);
      }
      if (option.defaultValue !== undefined) {
        const showDefault = option.required || option.optional || option.isBoolean() && typeof option.defaultValue === "boolean";
        if (showDefault) {
          extraInfo.push(`default: ${option.defaultValueDescription || JSON.stringify(option.defaultValue)}`);
        }
      }
      if (option.presetArg !== undefined && option.optional) {
        extraInfo.push(`preset: ${JSON.stringify(option.presetArg)}`);
      }
      if (option.envVar !== undefined) {
        extraInfo.push(`env: ${option.envVar}`);
      }
      if (extraInfo.length > 0) {
        const extraDescription = `(${extraInfo.join(", ")})`;
        if (option.description) {
          return `${option.description} ${extraDescription}`;
        }
        return extraDescription;
      }
      return option.description;
    }
    argumentDescription(argument) {
      const extraInfo = [];
      if (argument.argChoices) {
        extraInfo.push(`choices: ${argument.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`);
      }
      if (argument.defaultValue !== undefined) {
        extraInfo.push(`default: ${argument.defaultValueDescription || JSON.stringify(argument.defaultValue)}`);
      }
      if (extraInfo.length > 0) {
        const extraDescription = `(${extraInfo.join(", ")})`;
        if (argument.description) {
          return `${argument.description} ${extraDescription}`;
        }
        return extraDescription;
      }
      return argument.description;
    }
    formatItemList(heading, items, helper) {
      if (items.length === 0)
        return [];
      return [helper.styleTitle(heading), ...items, ""];
    }
    groupItems(unsortedItems, visibleItems, getGroup) {
      const result = new Map;
      unsortedItems.forEach((item) => {
        const group = getGroup(item);
        if (!result.has(group))
          result.set(group, []);
      });
      visibleItems.forEach((item) => {
        const group = getGroup(item);
        if (!result.has(group)) {
          result.set(group, []);
        }
        result.get(group).push(item);
      });
      return result;
    }
    formatHelp(cmd, helper) {
      const termWidth = helper.padWidth(cmd, helper);
      const helpWidth = helper.helpWidth ?? 80;
      function callFormatItem(term, description) {
        return helper.formatItem(term, termWidth, description, helper);
      }
      let output = [
        `${helper.styleTitle("Usage:")} ${helper.styleUsage(helper.commandUsage(cmd))}`,
        ""
      ];
      const commandDescription = helper.commandDescription(cmd);
      if (commandDescription.length > 0) {
        output = output.concat([
          helper.boxWrap(helper.styleCommandDescription(commandDescription), helpWidth),
          ""
        ]);
      }
      const argumentList = helper.visibleArguments(cmd).map((argument) => {
        return callFormatItem(helper.styleArgumentTerm(helper.argumentTerm(argument)), helper.styleArgumentDescription(helper.argumentDescription(argument)));
      });
      output = output.concat(this.formatItemList("Arguments:", argumentList, helper));
      const optionGroups = this.groupItems(cmd.options, helper.visibleOptions(cmd), (option) => option.helpGroupHeading ?? "Options:");
      optionGroups.forEach((options, group) => {
        const optionList = options.map((option) => {
          return callFormatItem(helper.styleOptionTerm(helper.optionTerm(option)), helper.styleOptionDescription(helper.optionDescription(option)));
        });
        output = output.concat(this.formatItemList(group, optionList, helper));
      });
      if (helper.showGlobalOptions) {
        const globalOptionList = helper.visibleGlobalOptions(cmd).map((option) => {
          return callFormatItem(helper.styleOptionTerm(helper.optionTerm(option)), helper.styleOptionDescription(helper.optionDescription(option)));
        });
        output = output.concat(this.formatItemList("Global Options:", globalOptionList, helper));
      }
      const commandGroups = this.groupItems(cmd.commands, helper.visibleCommands(cmd), (sub) => sub.helpGroup() || "Commands:");
      commandGroups.forEach((commands, group) => {
        const commandList = commands.map((sub) => {
          return callFormatItem(helper.styleSubcommandTerm(helper.subcommandTerm(sub)), helper.styleSubcommandDescription(helper.subcommandDescription(sub)));
        });
        output = output.concat(this.formatItemList(group, commandList, helper));
      });
      return output.join(`
`);
    }
    displayWidth(str) {
      return stripColor(str).length;
    }
    styleTitle(str) {
      return str;
    }
    styleUsage(str) {
      return str.split(" ").map((word) => {
        if (word === "[options]")
          return this.styleOptionText(word);
        if (word === "[command]")
          return this.styleSubcommandText(word);
        if (word[0] === "[" || word[0] === "<")
          return this.styleArgumentText(word);
        return this.styleCommandText(word);
      }).join(" ");
    }
    styleCommandDescription(str) {
      return this.styleDescriptionText(str);
    }
    styleOptionDescription(str) {
      return this.styleDescriptionText(str);
    }
    styleSubcommandDescription(str) {
      return this.styleDescriptionText(str);
    }
    styleArgumentDescription(str) {
      return this.styleDescriptionText(str);
    }
    styleDescriptionText(str) {
      return str;
    }
    styleOptionTerm(str) {
      return this.styleOptionText(str);
    }
    styleSubcommandTerm(str) {
      return str.split(" ").map((word) => {
        if (word === "[options]")
          return this.styleOptionText(word);
        if (word[0] === "[" || word[0] === "<")
          return this.styleArgumentText(word);
        return this.styleSubcommandText(word);
      }).join(" ");
    }
    styleArgumentTerm(str) {
      return this.styleArgumentText(str);
    }
    styleOptionText(str) {
      return str;
    }
    styleArgumentText(str) {
      return str;
    }
    styleSubcommandText(str) {
      return str;
    }
    styleCommandText(str) {
      return str;
    }
    padWidth(cmd, helper) {
      return Math.max(helper.longestOptionTermLength(cmd, helper), helper.longestGlobalOptionTermLength(cmd, helper), helper.longestSubcommandTermLength(cmd, helper), helper.longestArgumentTermLength(cmd, helper));
    }
    preformatted(str) {
      return /\n[^\S\r\n]/.test(str);
    }
    formatItem(term, termWidth, description, helper) {
      const itemIndent = 2;
      const itemIndentStr = " ".repeat(itemIndent);
      if (!description)
        return itemIndentStr + term;
      const paddedTerm = term.padEnd(termWidth + term.length - helper.displayWidth(term));
      const spacerWidth = 2;
      const helpWidth = this.helpWidth ?? 80;
      const remainingWidth = helpWidth - termWidth - spacerWidth - itemIndent;
      let formattedDescription;
      if (remainingWidth < this.minWidthToWrap || helper.preformatted(description)) {
        formattedDescription = description;
      } else {
        const wrappedDescription = helper.boxWrap(description, remainingWidth);
        formattedDescription = wrappedDescription.replace(/\n/g, `
` + " ".repeat(termWidth + spacerWidth));
      }
      return itemIndentStr + paddedTerm + " ".repeat(spacerWidth) + formattedDescription.replace(/\n/g, `
${itemIndentStr}`);
    }
    boxWrap(str, width) {
      if (width < this.minWidthToWrap)
        return str;
      const rawLines = str.split(/\r\n|\n/);
      const chunkPattern = /[\s]*[^\s]+/g;
      const wrappedLines = [];
      rawLines.forEach((line) => {
        const chunks = line.match(chunkPattern);
        if (chunks === null) {
          wrappedLines.push("");
          return;
        }
        let sumChunks = [chunks.shift()];
        let sumWidth = this.displayWidth(sumChunks[0]);
        chunks.forEach((chunk) => {
          const visibleWidth = this.displayWidth(chunk);
          if (sumWidth + visibleWidth <= width) {
            sumChunks.push(chunk);
            sumWidth += visibleWidth;
            return;
          }
          wrappedLines.push(sumChunks.join(""));
          const nextChunk = chunk.trimStart();
          sumChunks = [nextChunk];
          sumWidth = this.displayWidth(nextChunk);
        });
        wrappedLines.push(sumChunks.join(""));
      });
      return wrappedLines.join(`
`);
    }
  }
  function stripColor(str) {
    const sgrPattern = /\x1b\[\d*(;\d*)*m/g;
    return str.replace(sgrPattern, "");
  }
  exports.Help = Help;
  exports.stripColor = stripColor;
});

// ../node_modules/commander/lib/option.js
var require_option = __commonJS((exports) => {
  var { InvalidArgumentError } = require_error();

  class Option {
    constructor(flags, description) {
      this.flags = flags;
      this.description = description || "";
      this.required = flags.includes("<");
      this.optional = flags.includes("[");
      this.variadic = /\w\.\.\.[>\]]$/.test(flags);
      this.mandatory = false;
      const optionFlags = splitOptionFlags(flags);
      this.short = optionFlags.shortFlag;
      this.long = optionFlags.longFlag;
      this.negate = false;
      if (this.long) {
        this.negate = this.long.startsWith("--no-");
      }
      this.defaultValue = undefined;
      this.defaultValueDescription = undefined;
      this.presetArg = undefined;
      this.envVar = undefined;
      this.parseArg = undefined;
      this.hidden = false;
      this.argChoices = undefined;
      this.conflictsWith = [];
      this.implied = undefined;
      this.helpGroupHeading = undefined;
    }
    default(value, description) {
      this.defaultValue = value;
      this.defaultValueDescription = description;
      return this;
    }
    preset(arg) {
      this.presetArg = arg;
      return this;
    }
    conflicts(names) {
      this.conflictsWith = this.conflictsWith.concat(names);
      return this;
    }
    implies(impliedOptionValues) {
      let newImplied = impliedOptionValues;
      if (typeof impliedOptionValues === "string") {
        newImplied = { [impliedOptionValues]: true };
      }
      this.implied = Object.assign(this.implied || {}, newImplied);
      return this;
    }
    env(name) {
      this.envVar = name;
      return this;
    }
    argParser(fn) {
      this.parseArg = fn;
      return this;
    }
    makeOptionMandatory(mandatory = true) {
      this.mandatory = !!mandatory;
      return this;
    }
    hideHelp(hide = true) {
      this.hidden = !!hide;
      return this;
    }
    _collectValue(value, previous) {
      if (previous === this.defaultValue || !Array.isArray(previous)) {
        return [value];
      }
      previous.push(value);
      return previous;
    }
    choices(values) {
      this.argChoices = values.slice();
      this.parseArg = (arg, previous) => {
        if (!this.argChoices.includes(arg)) {
          throw new InvalidArgumentError(`Allowed choices are ${this.argChoices.join(", ")}.`);
        }
        if (this.variadic) {
          return this._collectValue(arg, previous);
        }
        return arg;
      };
      return this;
    }
    name() {
      if (this.long) {
        return this.long.replace(/^--/, "");
      }
      return this.short.replace(/^-/, "");
    }
    attributeName() {
      if (this.negate) {
        return camelcase(this.name().replace(/^no-/, ""));
      }
      return camelcase(this.name());
    }
    helpGroup(heading) {
      this.helpGroupHeading = heading;
      return this;
    }
    is(arg) {
      return this.short === arg || this.long === arg;
    }
    isBoolean() {
      return !this.required && !this.optional && !this.negate;
    }
  }

  class DualOptions {
    constructor(options) {
      this.positiveOptions = new Map;
      this.negativeOptions = new Map;
      this.dualOptions = new Set;
      options.forEach((option) => {
        if (option.negate) {
          this.negativeOptions.set(option.attributeName(), option);
        } else {
          this.positiveOptions.set(option.attributeName(), option);
        }
      });
      this.negativeOptions.forEach((value, key) => {
        if (this.positiveOptions.has(key)) {
          this.dualOptions.add(key);
        }
      });
    }
    valueFromOption(value, option) {
      const optionKey = option.attributeName();
      if (!this.dualOptions.has(optionKey))
        return true;
      const preset = this.negativeOptions.get(optionKey).presetArg;
      const negativeValue = preset !== undefined ? preset : false;
      return option.negate === (negativeValue === value);
    }
  }
  function camelcase(str) {
    return str.split("-").reduce((str2, word) => {
      return str2 + word[0].toUpperCase() + word.slice(1);
    });
  }
  function splitOptionFlags(flags) {
    let shortFlag;
    let longFlag;
    const shortFlagExp = /^-[^-]$/;
    const longFlagExp = /^--[^-]/;
    const flagParts = flags.split(/[ |,]+/).concat("guard");
    if (shortFlagExp.test(flagParts[0]))
      shortFlag = flagParts.shift();
    if (longFlagExp.test(flagParts[0]))
      longFlag = flagParts.shift();
    if (!shortFlag && shortFlagExp.test(flagParts[0]))
      shortFlag = flagParts.shift();
    if (!shortFlag && longFlagExp.test(flagParts[0])) {
      shortFlag = longFlag;
      longFlag = flagParts.shift();
    }
    if (flagParts[0].startsWith("-")) {
      const unsupportedFlag = flagParts[0];
      const baseError = `option creation failed due to '${unsupportedFlag}' in option flags '${flags}'`;
      if (/^-[^-][^-]/.test(unsupportedFlag))
        throw new Error(`${baseError}
- a short flag is a single dash and a single character
  - either use a single dash and a single character (for a short flag)
  - or use a double dash for a long option (and can have two, like '--ws, --workspace')`);
      if (shortFlagExp.test(unsupportedFlag))
        throw new Error(`${baseError}
- too many short flags`);
      if (longFlagExp.test(unsupportedFlag))
        throw new Error(`${baseError}
- too many long flags`);
      throw new Error(`${baseError}
- unrecognised flag format`);
    }
    if (shortFlag === undefined && longFlag === undefined)
      throw new Error(`option creation failed due to no flags found in '${flags}'.`);
    return { shortFlag, longFlag };
  }
  exports.Option = Option;
  exports.DualOptions = DualOptions;
});

// ../node_modules/commander/lib/suggestSimilar.js
var require_suggestSimilar = __commonJS((exports) => {
  var maxDistance = 3;
  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > maxDistance)
      return Math.max(a.length, b.length);
    const d = [];
    for (let i = 0;i <= a.length; i++) {
      d[i] = [i];
    }
    for (let j = 0;j <= b.length; j++) {
      d[0][j] = j;
    }
    for (let j = 1;j <= b.length; j++) {
      for (let i = 1;i <= a.length; i++) {
        let cost = 1;
        if (a[i - 1] === b[j - 1]) {
          cost = 0;
        } else {
          cost = 1;
        }
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[a.length][b.length];
  }
  function suggestSimilar(word, candidates) {
    if (!candidates || candidates.length === 0)
      return "";
    candidates = Array.from(new Set(candidates));
    const searchingOptions = word.startsWith("--");
    if (searchingOptions) {
      word = word.slice(2);
      candidates = candidates.map((candidate) => candidate.slice(2));
    }
    let similar = [];
    let bestDistance = maxDistance;
    const minSimilarity = 0.4;
    candidates.forEach((candidate) => {
      if (candidate.length <= 1)
        return;
      const distance = editDistance(word, candidate);
      const length = Math.max(word.length, candidate.length);
      const similarity = (length - distance) / length;
      if (similarity > minSimilarity) {
        if (distance < bestDistance) {
          bestDistance = distance;
          similar = [candidate];
        } else if (distance === bestDistance) {
          similar.push(candidate);
        }
      }
    });
    similar.sort((a, b) => a.localeCompare(b));
    if (searchingOptions) {
      similar = similar.map((candidate) => `--${candidate}`);
    }
    if (similar.length > 1) {
      return `
(Did you mean one of ${similar.join(", ")}?)`;
    }
    if (similar.length === 1) {
      return `
(Did you mean ${similar[0]}?)`;
    }
    return "";
  }
  exports.suggestSimilar = suggestSimilar;
});

// ../node_modules/commander/lib/command.js
var require_command = __commonJS((exports) => {
  var EventEmitter = __require("node:events").EventEmitter;
  var childProcess = __require("node:child_process");
  var path = __require("node:path");
  var fs = __require("node:fs");
  var process2 = __require("node:process");
  var { Argument, humanReadableArgName } = require_argument();
  var { CommanderError } = require_error();
  var { Help, stripColor } = require_help();
  var { Option, DualOptions } = require_option();
  var { suggestSimilar } = require_suggestSimilar();

  class Command extends EventEmitter {
    constructor(name) {
      super();
      this.commands = [];
      this.options = [];
      this.parent = null;
      this._allowUnknownOption = false;
      this._allowExcessArguments = false;
      this.registeredArguments = [];
      this._args = this.registeredArguments;
      this.args = [];
      this.rawArgs = [];
      this.processedArgs = [];
      this._scriptPath = null;
      this._name = name || "";
      this._optionValues = {};
      this._optionValueSources = {};
      this._storeOptionsAsProperties = false;
      this._actionHandler = null;
      this._executableHandler = false;
      this._executableFile = null;
      this._executableDir = null;
      this._defaultCommandName = null;
      this._exitCallback = null;
      this._aliases = [];
      this._combineFlagAndOptionalValue = true;
      this._description = "";
      this._summary = "";
      this._argsDescription = undefined;
      this._enablePositionalOptions = false;
      this._passThroughOptions = false;
      this._lifeCycleHooks = {};
      this._showHelpAfterError = false;
      this._showSuggestionAfterError = true;
      this._savedState = null;
      this._outputConfiguration = {
        writeOut: (str) => process2.stdout.write(str),
        writeErr: (str) => process2.stderr.write(str),
        outputError: (str, write) => write(str),
        getOutHelpWidth: () => process2.stdout.isTTY ? process2.stdout.columns : undefined,
        getErrHelpWidth: () => process2.stderr.isTTY ? process2.stderr.columns : undefined,
        getOutHasColors: () => useColor() ?? (process2.stdout.isTTY && process2.stdout.hasColors?.()),
        getErrHasColors: () => useColor() ?? (process2.stderr.isTTY && process2.stderr.hasColors?.()),
        stripColor: (str) => stripColor(str)
      };
      this._hidden = false;
      this._helpOption = undefined;
      this._addImplicitHelpCommand = undefined;
      this._helpCommand = undefined;
      this._helpConfiguration = {};
      this._helpGroupHeading = undefined;
      this._defaultCommandGroup = undefined;
      this._defaultOptionGroup = undefined;
    }
    copyInheritedSettings(sourceCommand) {
      this._outputConfiguration = sourceCommand._outputConfiguration;
      this._helpOption = sourceCommand._helpOption;
      this._helpCommand = sourceCommand._helpCommand;
      this._helpConfiguration = sourceCommand._helpConfiguration;
      this._exitCallback = sourceCommand._exitCallback;
      this._storeOptionsAsProperties = sourceCommand._storeOptionsAsProperties;
      this._combineFlagAndOptionalValue = sourceCommand._combineFlagAndOptionalValue;
      this._allowExcessArguments = sourceCommand._allowExcessArguments;
      this._enablePositionalOptions = sourceCommand._enablePositionalOptions;
      this._showHelpAfterError = sourceCommand._showHelpAfterError;
      this._showSuggestionAfterError = sourceCommand._showSuggestionAfterError;
      return this;
    }
    _getCommandAndAncestors() {
      const result = [];
      for (let command = this;command; command = command.parent) {
        result.push(command);
      }
      return result;
    }
    command(nameAndArgs, actionOptsOrExecDesc, execOpts) {
      let desc = actionOptsOrExecDesc;
      let opts = execOpts;
      if (typeof desc === "object" && desc !== null) {
        opts = desc;
        desc = null;
      }
      opts = opts || {};
      const [, name, args] = nameAndArgs.match(/([^ ]+) *(.*)/);
      const cmd = this.createCommand(name);
      if (desc) {
        cmd.description(desc);
        cmd._executableHandler = true;
      }
      if (opts.isDefault)
        this._defaultCommandName = cmd._name;
      cmd._hidden = !!(opts.noHelp || opts.hidden);
      cmd._executableFile = opts.executableFile || null;
      if (args)
        cmd.arguments(args);
      this._registerCommand(cmd);
      cmd.parent = this;
      cmd.copyInheritedSettings(this);
      if (desc)
        return this;
      return cmd;
    }
    createCommand(name) {
      return new Command(name);
    }
    createHelp() {
      return Object.assign(new Help, this.configureHelp());
    }
    configureHelp(configuration) {
      if (configuration === undefined)
        return this._helpConfiguration;
      this._helpConfiguration = configuration;
      return this;
    }
    configureOutput(configuration) {
      if (configuration === undefined)
        return this._outputConfiguration;
      this._outputConfiguration = {
        ...this._outputConfiguration,
        ...configuration
      };
      return this;
    }
    showHelpAfterError(displayHelp = true) {
      if (typeof displayHelp !== "string")
        displayHelp = !!displayHelp;
      this._showHelpAfterError = displayHelp;
      return this;
    }
    showSuggestionAfterError(displaySuggestion = true) {
      this._showSuggestionAfterError = !!displaySuggestion;
      return this;
    }
    addCommand(cmd, opts) {
      if (!cmd._name) {
        throw new Error(`Command passed to .addCommand() must have a name
- specify the name in Command constructor or using .name()`);
      }
      opts = opts || {};
      if (opts.isDefault)
        this._defaultCommandName = cmd._name;
      if (opts.noHelp || opts.hidden)
        cmd._hidden = true;
      this._registerCommand(cmd);
      cmd.parent = this;
      cmd._checkForBrokenPassThrough();
      return this;
    }
    createArgument(name, description) {
      return new Argument(name, description);
    }
    argument(name, description, parseArg, defaultValue) {
      const argument = this.createArgument(name, description);
      if (typeof parseArg === "function") {
        argument.default(defaultValue).argParser(parseArg);
      } else {
        argument.default(parseArg);
      }
      this.addArgument(argument);
      return this;
    }
    arguments(names) {
      names.trim().split(/ +/).forEach((detail) => {
        this.argument(detail);
      });
      return this;
    }
    addArgument(argument) {
      const previousArgument = this.registeredArguments.slice(-1)[0];
      if (previousArgument?.variadic) {
        throw new Error(`only the last argument can be variadic '${previousArgument.name()}'`);
      }
      if (argument.required && argument.defaultValue !== undefined && argument.parseArg === undefined) {
        throw new Error(`a default value for a required argument is never used: '${argument.name()}'`);
      }
      this.registeredArguments.push(argument);
      return this;
    }
    helpCommand(enableOrNameAndArgs, description) {
      if (typeof enableOrNameAndArgs === "boolean") {
        this._addImplicitHelpCommand = enableOrNameAndArgs;
        if (enableOrNameAndArgs && this._defaultCommandGroup) {
          this._initCommandGroup(this._getHelpCommand());
        }
        return this;
      }
      const nameAndArgs = enableOrNameAndArgs ?? "help [command]";
      const [, helpName, helpArgs] = nameAndArgs.match(/([^ ]+) *(.*)/);
      const helpDescription = description ?? "display help for command";
      const helpCommand = this.createCommand(helpName);
      helpCommand.helpOption(false);
      if (helpArgs)
        helpCommand.arguments(helpArgs);
      if (helpDescription)
        helpCommand.description(helpDescription);
      this._addImplicitHelpCommand = true;
      this._helpCommand = helpCommand;
      if (enableOrNameAndArgs || description)
        this._initCommandGroup(helpCommand);
      return this;
    }
    addHelpCommand(helpCommand, deprecatedDescription) {
      if (typeof helpCommand !== "object") {
        this.helpCommand(helpCommand, deprecatedDescription);
        return this;
      }
      this._addImplicitHelpCommand = true;
      this._helpCommand = helpCommand;
      this._initCommandGroup(helpCommand);
      return this;
    }
    _getHelpCommand() {
      const hasImplicitHelpCommand = this._addImplicitHelpCommand ?? (this.commands.length && !this._actionHandler && !this._findCommand("help"));
      if (hasImplicitHelpCommand) {
        if (this._helpCommand === undefined) {
          this.helpCommand(undefined, undefined);
        }
        return this._helpCommand;
      }
      return null;
    }
    hook(event, listener) {
      const allowedValues = ["preSubcommand", "preAction", "postAction"];
      if (!allowedValues.includes(event)) {
        throw new Error(`Unexpected value for event passed to hook : '${event}'.
Expecting one of '${allowedValues.join("', '")}'`);
      }
      if (this._lifeCycleHooks[event]) {
        this._lifeCycleHooks[event].push(listener);
      } else {
        this._lifeCycleHooks[event] = [listener];
      }
      return this;
    }
    exitOverride(fn) {
      if (fn) {
        this._exitCallback = fn;
      } else {
        this._exitCallback = (err) => {
          if (err.code !== "commander.executeSubCommandAsync") {
            throw err;
          } else {}
        };
      }
      return this;
    }
    _exit(exitCode, code, message) {
      if (this._exitCallback) {
        this._exitCallback(new CommanderError(exitCode, code, message));
      }
      process2.exit(exitCode);
    }
    action(fn) {
      const listener = (args) => {
        const expectedArgsCount = this.registeredArguments.length;
        const actionArgs = args.slice(0, expectedArgsCount);
        if (this._storeOptionsAsProperties) {
          actionArgs[expectedArgsCount] = this;
        } else {
          actionArgs[expectedArgsCount] = this.opts();
        }
        actionArgs.push(this);
        return fn.apply(this, actionArgs);
      };
      this._actionHandler = listener;
      return this;
    }
    createOption(flags, description) {
      return new Option(flags, description);
    }
    _callParseArg(target, value, previous, invalidArgumentMessage) {
      try {
        return target.parseArg(value, previous);
      } catch (err) {
        if (err.code === "commander.invalidArgument") {
          const message = `${invalidArgumentMessage} ${err.message}`;
          this.error(message, { exitCode: err.exitCode, code: err.code });
        }
        throw err;
      }
    }
    _registerOption(option) {
      const matchingOption = option.short && this._findOption(option.short) || option.long && this._findOption(option.long);
      if (matchingOption) {
        const matchingFlag = option.long && this._findOption(option.long) ? option.long : option.short;
        throw new Error(`Cannot add option '${option.flags}'${this._name && ` to command '${this._name}'`} due to conflicting flag '${matchingFlag}'
-  already used by option '${matchingOption.flags}'`);
      }
      this._initOptionGroup(option);
      this.options.push(option);
    }
    _registerCommand(command) {
      const knownBy = (cmd) => {
        return [cmd.name()].concat(cmd.aliases());
      };
      const alreadyUsed = knownBy(command).find((name) => this._findCommand(name));
      if (alreadyUsed) {
        const existingCmd = knownBy(this._findCommand(alreadyUsed)).join("|");
        const newCmd = knownBy(command).join("|");
        throw new Error(`cannot add command '${newCmd}' as already have command '${existingCmd}'`);
      }
      this._initCommandGroup(command);
      this.commands.push(command);
    }
    addOption(option) {
      this._registerOption(option);
      const oname = option.name();
      const name = option.attributeName();
      if (option.negate) {
        const positiveLongFlag = option.long.replace(/^--no-/, "--");
        if (!this._findOption(positiveLongFlag)) {
          this.setOptionValueWithSource(name, option.defaultValue === undefined ? true : option.defaultValue, "default");
        }
      } else if (option.defaultValue !== undefined) {
        this.setOptionValueWithSource(name, option.defaultValue, "default");
      }
      const handleOptionValue = (val, invalidValueMessage, valueSource) => {
        if (val == null && option.presetArg !== undefined) {
          val = option.presetArg;
        }
        const oldValue = this.getOptionValue(name);
        if (val !== null && option.parseArg) {
          val = this._callParseArg(option, val, oldValue, invalidValueMessage);
        } else if (val !== null && option.variadic) {
          val = option._collectValue(val, oldValue);
        }
        if (val == null) {
          if (option.negate) {
            val = false;
          } else if (option.isBoolean() || option.optional) {
            val = true;
          } else {
            val = "";
          }
        }
        this.setOptionValueWithSource(name, val, valueSource);
      };
      this.on("option:" + oname, (val) => {
        const invalidValueMessage = `error: option '${option.flags}' argument '${val}' is invalid.`;
        handleOptionValue(val, invalidValueMessage, "cli");
      });
      if (option.envVar) {
        this.on("optionEnv:" + oname, (val) => {
          const invalidValueMessage = `error: option '${option.flags}' value '${val}' from env '${option.envVar}' is invalid.`;
          handleOptionValue(val, invalidValueMessage, "env");
        });
      }
      return this;
    }
    _optionEx(config, flags, description, fn, defaultValue) {
      if (typeof flags === "object" && flags instanceof Option) {
        throw new Error("To add an Option object use addOption() instead of option() or requiredOption()");
      }
      const option = this.createOption(flags, description);
      option.makeOptionMandatory(!!config.mandatory);
      if (typeof fn === "function") {
        option.default(defaultValue).argParser(fn);
      } else if (fn instanceof RegExp) {
        const regex = fn;
        fn = (val, def) => {
          const m = regex.exec(val);
          return m ? m[0] : def;
        };
        option.default(defaultValue).argParser(fn);
      } else {
        option.default(fn);
      }
      return this.addOption(option);
    }
    option(flags, description, parseArg, defaultValue) {
      return this._optionEx({}, flags, description, parseArg, defaultValue);
    }
    requiredOption(flags, description, parseArg, defaultValue) {
      return this._optionEx({ mandatory: true }, flags, description, parseArg, defaultValue);
    }
    combineFlagAndOptionalValue(combine = true) {
      this._combineFlagAndOptionalValue = !!combine;
      return this;
    }
    allowUnknownOption(allowUnknown = true) {
      this._allowUnknownOption = !!allowUnknown;
      return this;
    }
    allowExcessArguments(allowExcess = true) {
      this._allowExcessArguments = !!allowExcess;
      return this;
    }
    enablePositionalOptions(positional = true) {
      this._enablePositionalOptions = !!positional;
      return this;
    }
    passThroughOptions(passThrough = true) {
      this._passThroughOptions = !!passThrough;
      this._checkForBrokenPassThrough();
      return this;
    }
    _checkForBrokenPassThrough() {
      if (this.parent && this._passThroughOptions && !this.parent._enablePositionalOptions) {
        throw new Error(`passThroughOptions cannot be used for '${this._name}' without turning on enablePositionalOptions for parent command(s)`);
      }
    }
    storeOptionsAsProperties(storeAsProperties = true) {
      if (this.options.length) {
        throw new Error("call .storeOptionsAsProperties() before adding options");
      }
      if (Object.keys(this._optionValues).length) {
        throw new Error("call .storeOptionsAsProperties() before setting option values");
      }
      this._storeOptionsAsProperties = !!storeAsProperties;
      return this;
    }
    getOptionValue(key) {
      if (this._storeOptionsAsProperties) {
        return this[key];
      }
      return this._optionValues[key];
    }
    setOptionValue(key, value) {
      return this.setOptionValueWithSource(key, value, undefined);
    }
    setOptionValueWithSource(key, value, source) {
      if (this._storeOptionsAsProperties) {
        this[key] = value;
      } else {
        this._optionValues[key] = value;
      }
      this._optionValueSources[key] = source;
      return this;
    }
    getOptionValueSource(key) {
      return this._optionValueSources[key];
    }
    getOptionValueSourceWithGlobals(key) {
      let source;
      this._getCommandAndAncestors().forEach((cmd) => {
        if (cmd.getOptionValueSource(key) !== undefined) {
          source = cmd.getOptionValueSource(key);
        }
      });
      return source;
    }
    _prepareUserArgs(argv, parseOptions) {
      if (argv !== undefined && !Array.isArray(argv)) {
        throw new Error("first parameter to parse must be array or undefined");
      }
      parseOptions = parseOptions || {};
      if (argv === undefined && parseOptions.from === undefined) {
        if (process2.versions?.electron) {
          parseOptions.from = "electron";
        }
        const execArgv = process2.execArgv ?? [];
        if (execArgv.includes("-e") || execArgv.includes("--eval") || execArgv.includes("-p") || execArgv.includes("--print")) {
          parseOptions.from = "eval";
        }
      }
      if (argv === undefined) {
        argv = process2.argv;
      }
      this.rawArgs = argv.slice();
      let userArgs;
      switch (parseOptions.from) {
        case undefined:
        case "node":
          this._scriptPath = argv[1];
          userArgs = argv.slice(2);
          break;
        case "electron":
          if (process2.defaultApp) {
            this._scriptPath = argv[1];
            userArgs = argv.slice(2);
          } else {
            userArgs = argv.slice(1);
          }
          break;
        case "user":
          userArgs = argv.slice(0);
          break;
        case "eval":
          userArgs = argv.slice(1);
          break;
        default:
          throw new Error(`unexpected parse option { from: '${parseOptions.from}' }`);
      }
      if (!this._name && this._scriptPath)
        this.nameFromFilename(this._scriptPath);
      this._name = this._name || "program";
      return userArgs;
    }
    parse(argv, parseOptions) {
      this._prepareForParse();
      const userArgs = this._prepareUserArgs(argv, parseOptions);
      this._parseCommand([], userArgs);
      return this;
    }
    async parseAsync(argv, parseOptions) {
      this._prepareForParse();
      const userArgs = this._prepareUserArgs(argv, parseOptions);
      await this._parseCommand([], userArgs);
      return this;
    }
    _prepareForParse() {
      if (this._savedState === null) {
        this.saveStateBeforeParse();
      } else {
        this.restoreStateBeforeParse();
      }
    }
    saveStateBeforeParse() {
      this._savedState = {
        _name: this._name,
        _optionValues: { ...this._optionValues },
        _optionValueSources: { ...this._optionValueSources }
      };
    }
    restoreStateBeforeParse() {
      if (this._storeOptionsAsProperties)
        throw new Error(`Can not call parse again when storeOptionsAsProperties is true.
- either make a new Command for each call to parse, or stop storing options as properties`);
      this._name = this._savedState._name;
      this._scriptPath = null;
      this.rawArgs = [];
      this._optionValues = { ...this._savedState._optionValues };
      this._optionValueSources = { ...this._savedState._optionValueSources };
      this.args = [];
      this.processedArgs = [];
    }
    _checkForMissingExecutable(executableFile, executableDir, subcommandName) {
      if (fs.existsSync(executableFile))
        return;
      const executableDirMessage = executableDir ? `searched for local subcommand relative to directory '${executableDir}'` : "no directory for search for local subcommand, use .executableDir() to supply a custom directory";
      const executableMissing = `'${executableFile}' does not exist
 - if '${subcommandName}' is not meant to be an executable command, remove description parameter from '.command()' and use '.description()' instead
 - if the default executable name is not suitable, use the executableFile option to supply a custom name or path
 - ${executableDirMessage}`;
      throw new Error(executableMissing);
    }
    _executeSubCommand(subcommand, args) {
      args = args.slice();
      let launchWithNode = false;
      const sourceExt = [".js", ".ts", ".tsx", ".mjs", ".cjs"];
      function findFile(baseDir, baseName) {
        const localBin = path.resolve(baseDir, baseName);
        if (fs.existsSync(localBin))
          return localBin;
        if (sourceExt.includes(path.extname(baseName)))
          return;
        const foundExt = sourceExt.find((ext) => fs.existsSync(`${localBin}${ext}`));
        if (foundExt)
          return `${localBin}${foundExt}`;
        return;
      }
      this._checkForMissingMandatoryOptions();
      this._checkForConflictingOptions();
      let executableFile = subcommand._executableFile || `${this._name}-${subcommand._name}`;
      let executableDir = this._executableDir || "";
      if (this._scriptPath) {
        let resolvedScriptPath;
        try {
          resolvedScriptPath = fs.realpathSync(this._scriptPath);
        } catch {
          resolvedScriptPath = this._scriptPath;
        }
        executableDir = path.resolve(path.dirname(resolvedScriptPath), executableDir);
      }
      if (executableDir) {
        let localFile = findFile(executableDir, executableFile);
        if (!localFile && !subcommand._executableFile && this._scriptPath) {
          const legacyName = path.basename(this._scriptPath, path.extname(this._scriptPath));
          if (legacyName !== this._name) {
            localFile = findFile(executableDir, `${legacyName}-${subcommand._name}`);
          }
        }
        executableFile = localFile || executableFile;
      }
      launchWithNode = sourceExt.includes(path.extname(executableFile));
      let proc;
      if (process2.platform !== "win32") {
        if (launchWithNode) {
          args.unshift(executableFile);
          args = incrementNodeInspectorPort(process2.execArgv).concat(args);
          proc = childProcess.spawn(process2.argv[0], args, { stdio: "inherit" });
        } else {
          proc = childProcess.spawn(executableFile, args, { stdio: "inherit" });
        }
      } else {
        this._checkForMissingExecutable(executableFile, executableDir, subcommand._name);
        args.unshift(executableFile);
        args = incrementNodeInspectorPort(process2.execArgv).concat(args);
        proc = childProcess.spawn(process2.execPath, args, { stdio: "inherit" });
      }
      if (!proc.killed) {
        const signals = ["SIGUSR1", "SIGUSR2", "SIGTERM", "SIGINT", "SIGHUP"];
        signals.forEach((signal) => {
          process2.on(signal, () => {
            if (proc.killed === false && proc.exitCode === null) {
              proc.kill(signal);
            }
          });
        });
      }
      const exitCallback = this._exitCallback;
      proc.on("close", (code) => {
        code = code ?? 1;
        if (!exitCallback) {
          process2.exit(code);
        } else {
          exitCallback(new CommanderError(code, "commander.executeSubCommandAsync", "(close)"));
        }
      });
      proc.on("error", (err) => {
        if (err.code === "ENOENT") {
          this._checkForMissingExecutable(executableFile, executableDir, subcommand._name);
        } else if (err.code === "EACCES") {
          throw new Error(`'${executableFile}' not executable`);
        }
        if (!exitCallback) {
          process2.exit(1);
        } else {
          const wrappedError = new CommanderError(1, "commander.executeSubCommandAsync", "(error)");
          wrappedError.nestedError = err;
          exitCallback(wrappedError);
        }
      });
      this.runningCommand = proc;
    }
    _dispatchSubcommand(commandName, operands, unknown) {
      const subCommand = this._findCommand(commandName);
      if (!subCommand)
        this.help({ error: true });
      subCommand._prepareForParse();
      let promiseChain;
      promiseChain = this._chainOrCallSubCommandHook(promiseChain, subCommand, "preSubcommand");
      promiseChain = this._chainOrCall(promiseChain, () => {
        if (subCommand._executableHandler) {
          this._executeSubCommand(subCommand, operands.concat(unknown));
        } else {
          return subCommand._parseCommand(operands, unknown);
        }
      });
      return promiseChain;
    }
    _dispatchHelpCommand(subcommandName) {
      if (!subcommandName) {
        this.help();
      }
      const subCommand = this._findCommand(subcommandName);
      if (subCommand && !subCommand._executableHandler) {
        subCommand.help();
      }
      return this._dispatchSubcommand(subcommandName, [], [this._getHelpOption()?.long ?? this._getHelpOption()?.short ?? "--help"]);
    }
    _checkNumberOfArguments() {
      this.registeredArguments.forEach((arg, i) => {
        if (arg.required && this.args[i] == null) {
          this.missingArgument(arg.name());
        }
      });
      if (this.registeredArguments.length > 0 && this.registeredArguments[this.registeredArguments.length - 1].variadic) {
        return;
      }
      if (this.args.length > this.registeredArguments.length) {
        this._excessArguments(this.args);
      }
    }
    _processArguments() {
      const myParseArg = (argument, value, previous) => {
        let parsedValue = value;
        if (value !== null && argument.parseArg) {
          const invalidValueMessage = `error: command-argument value '${value}' is invalid for argument '${argument.name()}'.`;
          parsedValue = this._callParseArg(argument, value, previous, invalidValueMessage);
        }
        return parsedValue;
      };
      this._checkNumberOfArguments();
      const processedArgs = [];
      this.registeredArguments.forEach((declaredArg, index) => {
        let value = declaredArg.defaultValue;
        if (declaredArg.variadic) {
          if (index < this.args.length) {
            value = this.args.slice(index);
            if (declaredArg.parseArg) {
              value = value.reduce((processed, v) => {
                return myParseArg(declaredArg, v, processed);
              }, declaredArg.defaultValue);
            }
          } else if (value === undefined) {
            value = [];
          }
        } else if (index < this.args.length) {
          value = this.args[index];
          if (declaredArg.parseArg) {
            value = myParseArg(declaredArg, value, declaredArg.defaultValue);
          }
        }
        processedArgs[index] = value;
      });
      this.processedArgs = processedArgs;
    }
    _chainOrCall(promise, fn) {
      if (promise?.then && typeof promise.then === "function") {
        return promise.then(() => fn());
      }
      return fn();
    }
    _chainOrCallHooks(promise, event) {
      let result = promise;
      const hooks = [];
      this._getCommandAndAncestors().reverse().filter((cmd) => cmd._lifeCycleHooks[event] !== undefined).forEach((hookedCommand) => {
        hookedCommand._lifeCycleHooks[event].forEach((callback) => {
          hooks.push({ hookedCommand, callback });
        });
      });
      if (event === "postAction") {
        hooks.reverse();
      }
      hooks.forEach((hookDetail) => {
        result = this._chainOrCall(result, () => {
          return hookDetail.callback(hookDetail.hookedCommand, this);
        });
      });
      return result;
    }
    _chainOrCallSubCommandHook(promise, subCommand, event) {
      let result = promise;
      if (this._lifeCycleHooks[event] !== undefined) {
        this._lifeCycleHooks[event].forEach((hook) => {
          result = this._chainOrCall(result, () => {
            return hook(this, subCommand);
          });
        });
      }
      return result;
    }
    _parseCommand(operands, unknown) {
      const parsed = this.parseOptions(unknown);
      this._parseOptionsEnv();
      this._parseOptionsImplied();
      operands = operands.concat(parsed.operands);
      unknown = parsed.unknown;
      this.args = operands.concat(unknown);
      if (operands && this._findCommand(operands[0])) {
        return this._dispatchSubcommand(operands[0], operands.slice(1), unknown);
      }
      if (this._getHelpCommand() && operands[0] === this._getHelpCommand().name()) {
        return this._dispatchHelpCommand(operands[1]);
      }
      if (this._defaultCommandName) {
        this._outputHelpIfRequested(unknown);
        return this._dispatchSubcommand(this._defaultCommandName, operands, unknown);
      }
      if (this.commands.length && this.args.length === 0 && !this._actionHandler && !this._defaultCommandName) {
        this.help({ error: true });
      }
      this._outputHelpIfRequested(parsed.unknown);
      this._checkForMissingMandatoryOptions();
      this._checkForConflictingOptions();
      const checkForUnknownOptions = () => {
        if (parsed.unknown.length > 0) {
          this.unknownOption(parsed.unknown[0]);
        }
      };
      const commandEvent = `command:${this.name()}`;
      if (this._actionHandler) {
        checkForUnknownOptions();
        this._processArguments();
        let promiseChain;
        promiseChain = this._chainOrCallHooks(promiseChain, "preAction");
        promiseChain = this._chainOrCall(promiseChain, () => this._actionHandler(this.processedArgs));
        if (this.parent) {
          promiseChain = this._chainOrCall(promiseChain, () => {
            this.parent.emit(commandEvent, operands, unknown);
          });
        }
        promiseChain = this._chainOrCallHooks(promiseChain, "postAction");
        return promiseChain;
      }
      if (this.parent?.listenerCount(commandEvent)) {
        checkForUnknownOptions();
        this._processArguments();
        this.parent.emit(commandEvent, operands, unknown);
      } else if (operands.length) {
        if (this._findCommand("*")) {
          return this._dispatchSubcommand("*", operands, unknown);
        }
        if (this.listenerCount("command:*")) {
          this.emit("command:*", operands, unknown);
        } else if (this.commands.length) {
          this.unknownCommand();
        } else {
          checkForUnknownOptions();
          this._processArguments();
        }
      } else if (this.commands.length) {
        checkForUnknownOptions();
        this.help({ error: true });
      } else {
        checkForUnknownOptions();
        this._processArguments();
      }
    }
    _findCommand(name) {
      if (!name)
        return;
      return this.commands.find((cmd) => cmd._name === name || cmd._aliases.includes(name));
    }
    _findOption(arg) {
      return this.options.find((option) => option.is(arg));
    }
    _checkForMissingMandatoryOptions() {
      this._getCommandAndAncestors().forEach((cmd) => {
        cmd.options.forEach((anOption) => {
          if (anOption.mandatory && cmd.getOptionValue(anOption.attributeName()) === undefined) {
            cmd.missingMandatoryOptionValue(anOption);
          }
        });
      });
    }
    _checkForConflictingLocalOptions() {
      const definedNonDefaultOptions = this.options.filter((option) => {
        const optionKey = option.attributeName();
        if (this.getOptionValue(optionKey) === undefined) {
          return false;
        }
        return this.getOptionValueSource(optionKey) !== "default";
      });
      const optionsWithConflicting = definedNonDefaultOptions.filter((option) => option.conflictsWith.length > 0);
      optionsWithConflicting.forEach((option) => {
        const conflictingAndDefined = definedNonDefaultOptions.find((defined) => option.conflictsWith.includes(defined.attributeName()));
        if (conflictingAndDefined) {
          this._conflictingOption(option, conflictingAndDefined);
        }
      });
    }
    _checkForConflictingOptions() {
      this._getCommandAndAncestors().forEach((cmd) => {
        cmd._checkForConflictingLocalOptions();
      });
    }
    parseOptions(args) {
      const operands = [];
      const unknown = [];
      let dest = operands;
      function maybeOption(arg) {
        return arg.length > 1 && arg[0] === "-";
      }
      const negativeNumberArg = (arg) => {
        if (!/^-(\d+|\d*\.\d+)(e[+-]?\d+)?$/.test(arg))
          return false;
        return !this._getCommandAndAncestors().some((cmd) => cmd.options.map((opt) => opt.short).some((short) => /^-\d$/.test(short)));
      };
      let activeVariadicOption = null;
      let activeGroup = null;
      let i = 0;
      while (i < args.length || activeGroup) {
        const arg = activeGroup ?? args[i++];
        activeGroup = null;
        if (arg === "--") {
          if (dest === unknown)
            dest.push(arg);
          dest.push(...args.slice(i));
          break;
        }
        if (activeVariadicOption && (!maybeOption(arg) || negativeNumberArg(arg))) {
          this.emit(`option:${activeVariadicOption.name()}`, arg);
          continue;
        }
        activeVariadicOption = null;
        if (maybeOption(arg)) {
          const option = this._findOption(arg);
          if (option) {
            if (option.required) {
              const value = args[i++];
              if (value === undefined)
                this.optionMissingArgument(option);
              this.emit(`option:${option.name()}`, value);
            } else if (option.optional) {
              let value = null;
              if (i < args.length && (!maybeOption(args[i]) || negativeNumberArg(args[i]))) {
                value = args[i++];
              }
              this.emit(`option:${option.name()}`, value);
            } else {
              this.emit(`option:${option.name()}`);
            }
            activeVariadicOption = option.variadic ? option : null;
            continue;
          }
        }
        if (arg.length > 2 && arg[0] === "-" && arg[1] !== "-") {
          const option = this._findOption(`-${arg[1]}`);
          if (option) {
            if (option.required || option.optional && this._combineFlagAndOptionalValue) {
              this.emit(`option:${option.name()}`, arg.slice(2));
            } else {
              this.emit(`option:${option.name()}`);
              activeGroup = `-${arg.slice(2)}`;
            }
            continue;
          }
        }
        if (/^--[^=]+=/.test(arg)) {
          const index = arg.indexOf("=");
          const option = this._findOption(arg.slice(0, index));
          if (option && (option.required || option.optional)) {
            this.emit(`option:${option.name()}`, arg.slice(index + 1));
            continue;
          }
        }
        if (dest === operands && maybeOption(arg) && !(this.commands.length === 0 && negativeNumberArg(arg))) {
          dest = unknown;
        }
        if ((this._enablePositionalOptions || this._passThroughOptions) && operands.length === 0 && unknown.length === 0) {
          if (this._findCommand(arg)) {
            operands.push(arg);
            unknown.push(...args.slice(i));
            break;
          } else if (this._getHelpCommand() && arg === this._getHelpCommand().name()) {
            operands.push(arg, ...args.slice(i));
            break;
          } else if (this._defaultCommandName) {
            unknown.push(arg, ...args.slice(i));
            break;
          }
        }
        if (this._passThroughOptions) {
          dest.push(arg, ...args.slice(i));
          break;
        }
        dest.push(arg);
      }
      return { operands, unknown };
    }
    opts() {
      if (this._storeOptionsAsProperties) {
        const result = {};
        const len = this.options.length;
        for (let i = 0;i < len; i++) {
          const key = this.options[i].attributeName();
          result[key] = key === this._versionOptionName ? this._version : this[key];
        }
        return result;
      }
      return this._optionValues;
    }
    optsWithGlobals() {
      return this._getCommandAndAncestors().reduce((combinedOptions, cmd) => Object.assign(combinedOptions, cmd.opts()), {});
    }
    error(message, errorOptions) {
      this._outputConfiguration.outputError(`${message}
`, this._outputConfiguration.writeErr);
      if (typeof this._showHelpAfterError === "string") {
        this._outputConfiguration.writeErr(`${this._showHelpAfterError}
`);
      } else if (this._showHelpAfterError) {
        this._outputConfiguration.writeErr(`
`);
        this.outputHelp({ error: true });
      }
      const config = errorOptions || {};
      const exitCode = config.exitCode || 1;
      const code = config.code || "commander.error";
      this._exit(exitCode, code, message);
    }
    _parseOptionsEnv() {
      this.options.forEach((option) => {
        if (option.envVar && option.envVar in process2.env) {
          const optionKey = option.attributeName();
          if (this.getOptionValue(optionKey) === undefined || ["default", "config", "env"].includes(this.getOptionValueSource(optionKey))) {
            if (option.required || option.optional) {
              this.emit(`optionEnv:${option.name()}`, process2.env[option.envVar]);
            } else {
              this.emit(`optionEnv:${option.name()}`);
            }
          }
        }
      });
    }
    _parseOptionsImplied() {
      const dualHelper = new DualOptions(this.options);
      const hasCustomOptionValue = (optionKey) => {
        return this.getOptionValue(optionKey) !== undefined && !["default", "implied"].includes(this.getOptionValueSource(optionKey));
      };
      this.options.filter((option) => option.implied !== undefined && hasCustomOptionValue(option.attributeName()) && dualHelper.valueFromOption(this.getOptionValue(option.attributeName()), option)).forEach((option) => {
        Object.keys(option.implied).filter((impliedKey) => !hasCustomOptionValue(impliedKey)).forEach((impliedKey) => {
          this.setOptionValueWithSource(impliedKey, option.implied[impliedKey], "implied");
        });
      });
    }
    missingArgument(name) {
      const message = `error: missing required argument '${name}'`;
      this.error(message, { code: "commander.missingArgument" });
    }
    optionMissingArgument(option) {
      const message = `error: option '${option.flags}' argument missing`;
      this.error(message, { code: "commander.optionMissingArgument" });
    }
    missingMandatoryOptionValue(option) {
      const message = `error: required option '${option.flags}' not specified`;
      this.error(message, { code: "commander.missingMandatoryOptionValue" });
    }
    _conflictingOption(option, conflictingOption) {
      const findBestOptionFromValue = (option2) => {
        const optionKey = option2.attributeName();
        const optionValue = this.getOptionValue(optionKey);
        const negativeOption = this.options.find((target) => target.negate && optionKey === target.attributeName());
        const positiveOption = this.options.find((target) => !target.negate && optionKey === target.attributeName());
        if (negativeOption && (negativeOption.presetArg === undefined && optionValue === false || negativeOption.presetArg !== undefined && optionValue === negativeOption.presetArg)) {
          return negativeOption;
        }
        return positiveOption || option2;
      };
      const getErrorMessage = (option2) => {
        const bestOption = findBestOptionFromValue(option2);
        const optionKey = bestOption.attributeName();
        const source = this.getOptionValueSource(optionKey);
        if (source === "env") {
          return `environment variable '${bestOption.envVar}'`;
        }
        return `option '${bestOption.flags}'`;
      };
      const message = `error: ${getErrorMessage(option)} cannot be used with ${getErrorMessage(conflictingOption)}`;
      this.error(message, { code: "commander.conflictingOption" });
    }
    unknownOption(flag) {
      if (this._allowUnknownOption)
        return;
      let suggestion = "";
      if (flag.startsWith("--") && this._showSuggestionAfterError) {
        let candidateFlags = [];
        let command = this;
        do {
          const moreFlags = command.createHelp().visibleOptions(command).filter((option) => option.long).map((option) => option.long);
          candidateFlags = candidateFlags.concat(moreFlags);
          command = command.parent;
        } while (command && !command._enablePositionalOptions);
        suggestion = suggestSimilar(flag, candidateFlags);
      }
      const message = `error: unknown option '${flag}'${suggestion}`;
      this.error(message, { code: "commander.unknownOption" });
    }
    _excessArguments(receivedArgs) {
      if (this._allowExcessArguments)
        return;
      const expected = this.registeredArguments.length;
      const s = expected === 1 ? "" : "s";
      const forSubcommand = this.parent ? ` for '${this.name()}'` : "";
      const message = `error: too many arguments${forSubcommand}. Expected ${expected} argument${s} but got ${receivedArgs.length}.`;
      this.error(message, { code: "commander.excessArguments" });
    }
    unknownCommand() {
      const unknownName = this.args[0];
      let suggestion = "";
      if (this._showSuggestionAfterError) {
        const candidateNames = [];
        this.createHelp().visibleCommands(this).forEach((command) => {
          candidateNames.push(command.name());
          if (command.alias())
            candidateNames.push(command.alias());
        });
        suggestion = suggestSimilar(unknownName, candidateNames);
      }
      const message = `error: unknown command '${unknownName}'${suggestion}`;
      this.error(message, { code: "commander.unknownCommand" });
    }
    version(str, flags, description) {
      if (str === undefined)
        return this._version;
      this._version = str;
      flags = flags || "-V, --version";
      description = description || "output the version number";
      const versionOption = this.createOption(flags, description);
      this._versionOptionName = versionOption.attributeName();
      this._registerOption(versionOption);
      this.on("option:" + versionOption.name(), () => {
        this._outputConfiguration.writeOut(`${str}
`);
        this._exit(0, "commander.version", str);
      });
      return this;
    }
    description(str, argsDescription) {
      if (str === undefined && argsDescription === undefined)
        return this._description;
      this._description = str;
      if (argsDescription) {
        this._argsDescription = argsDescription;
      }
      return this;
    }
    summary(str) {
      if (str === undefined)
        return this._summary;
      this._summary = str;
      return this;
    }
    alias(alias) {
      if (alias === undefined)
        return this._aliases[0];
      let command = this;
      if (this.commands.length !== 0 && this.commands[this.commands.length - 1]._executableHandler) {
        command = this.commands[this.commands.length - 1];
      }
      if (alias === command._name)
        throw new Error("Command alias can't be the same as its name");
      const matchingCommand = this.parent?._findCommand(alias);
      if (matchingCommand) {
        const existingCmd = [matchingCommand.name()].concat(matchingCommand.aliases()).join("|");
        throw new Error(`cannot add alias '${alias}' to command '${this.name()}' as already have command '${existingCmd}'`);
      }
      command._aliases.push(alias);
      return this;
    }
    aliases(aliases) {
      if (aliases === undefined)
        return this._aliases;
      aliases.forEach((alias) => this.alias(alias));
      return this;
    }
    usage(str) {
      if (str === undefined) {
        if (this._usage)
          return this._usage;
        const args = this.registeredArguments.map((arg) => {
          return humanReadableArgName(arg);
        });
        return [].concat(this.options.length || this._helpOption !== null ? "[options]" : [], this.commands.length ? "[command]" : [], this.registeredArguments.length ? args : []).join(" ");
      }
      this._usage = str;
      return this;
    }
    name(str) {
      if (str === undefined)
        return this._name;
      this._name = str;
      return this;
    }
    helpGroup(heading) {
      if (heading === undefined)
        return this._helpGroupHeading ?? "";
      this._helpGroupHeading = heading;
      return this;
    }
    commandsGroup(heading) {
      if (heading === undefined)
        return this._defaultCommandGroup ?? "";
      this._defaultCommandGroup = heading;
      return this;
    }
    optionsGroup(heading) {
      if (heading === undefined)
        return this._defaultOptionGroup ?? "";
      this._defaultOptionGroup = heading;
      return this;
    }
    _initOptionGroup(option) {
      if (this._defaultOptionGroup && !option.helpGroupHeading)
        option.helpGroup(this._defaultOptionGroup);
    }
    _initCommandGroup(cmd) {
      if (this._defaultCommandGroup && !cmd.helpGroup())
        cmd.helpGroup(this._defaultCommandGroup);
    }
    nameFromFilename(filename) {
      this._name = path.basename(filename, path.extname(filename));
      return this;
    }
    executableDir(path2) {
      if (path2 === undefined)
        return this._executableDir;
      this._executableDir = path2;
      return this;
    }
    helpInformation(contextOptions) {
      const helper = this.createHelp();
      const context = this._getOutputContext(contextOptions);
      helper.prepareContext({
        error: context.error,
        helpWidth: context.helpWidth,
        outputHasColors: context.hasColors
      });
      const text = helper.formatHelp(this, helper);
      if (context.hasColors)
        return text;
      return this._outputConfiguration.stripColor(text);
    }
    _getOutputContext(contextOptions) {
      contextOptions = contextOptions || {};
      const error = !!contextOptions.error;
      let baseWrite;
      let hasColors;
      let helpWidth;
      if (error) {
        baseWrite = (str) => this._outputConfiguration.writeErr(str);
        hasColors = this._outputConfiguration.getErrHasColors();
        helpWidth = this._outputConfiguration.getErrHelpWidth();
      } else {
        baseWrite = (str) => this._outputConfiguration.writeOut(str);
        hasColors = this._outputConfiguration.getOutHasColors();
        helpWidth = this._outputConfiguration.getOutHelpWidth();
      }
      const write = (str) => {
        if (!hasColors)
          str = this._outputConfiguration.stripColor(str);
        return baseWrite(str);
      };
      return { error, write, hasColors, helpWidth };
    }
    outputHelp(contextOptions) {
      let deprecatedCallback;
      if (typeof contextOptions === "function") {
        deprecatedCallback = contextOptions;
        contextOptions = undefined;
      }
      const outputContext = this._getOutputContext(contextOptions);
      const eventContext = {
        error: outputContext.error,
        write: outputContext.write,
        command: this
      };
      this._getCommandAndAncestors().reverse().forEach((command) => command.emit("beforeAllHelp", eventContext));
      this.emit("beforeHelp", eventContext);
      let helpInformation = this.helpInformation({ error: outputContext.error });
      if (deprecatedCallback) {
        helpInformation = deprecatedCallback(helpInformation);
        if (typeof helpInformation !== "string" && !Buffer.isBuffer(helpInformation)) {
          throw new Error("outputHelp callback must return a string or a Buffer");
        }
      }
      outputContext.write(helpInformation);
      if (this._getHelpOption()?.long) {
        this.emit(this._getHelpOption().long);
      }
      this.emit("afterHelp", eventContext);
      this._getCommandAndAncestors().forEach((command) => command.emit("afterAllHelp", eventContext));
    }
    helpOption(flags, description) {
      if (typeof flags === "boolean") {
        if (flags) {
          if (this._helpOption === null)
            this._helpOption = undefined;
          if (this._defaultOptionGroup) {
            this._initOptionGroup(this._getHelpOption());
          }
        } else {
          this._helpOption = null;
        }
        return this;
      }
      this._helpOption = this.createOption(flags ?? "-h, --help", description ?? "display help for command");
      if (flags || description)
        this._initOptionGroup(this._helpOption);
      return this;
    }
    _getHelpOption() {
      if (this._helpOption === undefined) {
        this.helpOption(undefined, undefined);
      }
      return this._helpOption;
    }
    addHelpOption(option) {
      this._helpOption = option;
      this._initOptionGroup(option);
      return this;
    }
    help(contextOptions) {
      this.outputHelp(contextOptions);
      let exitCode = Number(process2.exitCode ?? 0);
      if (exitCode === 0 && contextOptions && typeof contextOptions !== "function" && contextOptions.error) {
        exitCode = 1;
      }
      this._exit(exitCode, "commander.help", "(outputHelp)");
    }
    addHelpText(position, text) {
      const allowedValues = ["beforeAll", "before", "after", "afterAll"];
      if (!allowedValues.includes(position)) {
        throw new Error(`Unexpected value for position to addHelpText.
Expecting one of '${allowedValues.join("', '")}'`);
      }
      const helpEvent = `${position}Help`;
      this.on(helpEvent, (context) => {
        let helpStr;
        if (typeof text === "function") {
          helpStr = text({ error: context.error, command: context.command });
        } else {
          helpStr = text;
        }
        if (helpStr) {
          context.write(`${helpStr}
`);
        }
      });
      return this;
    }
    _outputHelpIfRequested(args) {
      const helpOption = this._getHelpOption();
      const helpRequested = helpOption && args.find((arg) => helpOption.is(arg));
      if (helpRequested) {
        this.outputHelp();
        this._exit(0, "commander.helpDisplayed", "(outputHelp)");
      }
    }
  }
  function incrementNodeInspectorPort(args) {
    return args.map((arg) => {
      if (!arg.startsWith("--inspect")) {
        return arg;
      }
      let debugOption;
      let debugHost = "127.0.0.1";
      let debugPort = "9229";
      let match;
      if ((match = arg.match(/^(--inspect(-brk)?)$/)) !== null) {
        debugOption = match[1];
      } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+)$/)) !== null) {
        debugOption = match[1];
        if (/^\d+$/.test(match[3])) {
          debugPort = match[3];
        } else {
          debugHost = match[3];
        }
      } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+):(\d+)$/)) !== null) {
        debugOption = match[1];
        debugHost = match[3];
        debugPort = match[4];
      }
      if (debugOption && debugPort !== "0") {
        return `${debugOption}=${debugHost}:${parseInt(debugPort) + 1}`;
      }
      return arg;
    });
  }
  function useColor() {
    if (process2.env.NO_COLOR || process2.env.FORCE_COLOR === "0" || process2.env.FORCE_COLOR === "false")
      return false;
    if (process2.env.FORCE_COLOR || process2.env.CLICOLOR_FORCE !== undefined)
      return true;
    return;
  }
  exports.Command = Command;
  exports.useColor = useColor;
});

// ../node_modules/commander/index.js
var require_commander = __commonJS((exports) => {
  var { Argument } = require_argument();
  var { Command } = require_command();
  var { CommanderError, InvalidArgumentError } = require_error();
  var { Help } = require_help();
  var { Option } = require_option();
  exports.program = new Command;
  exports.createCommand = (name) => new Command(name);
  exports.createOption = (flags, description) => new Option(flags, description);
  exports.createArgument = (name, description) => new Argument(name, description);
  exports.Command = Command;
  exports.Option = Option;
  exports.Argument = Argument;
  exports.Help = Help;
  exports.CommanderError = CommanderError;
  exports.InvalidArgumentError = InvalidArgumentError;
  exports.InvalidOptionArgumentError = InvalidArgumentError;
});

// ../node_modules/papaparse/papaparse.js
var require_papaparse = __commonJS((exports, module) => {
  (function(root, factory) {
    if (typeof define === "function" && define.amd) {
      define([], factory);
    } else if (typeof module === "object" && typeof exports !== "undefined") {
      module.exports = factory();
    } else {
      root.Papa = factory();
    }
  })(exports, function moduleFactory() {
    var global = function() {
      if (typeof self !== "undefined") {
        return self;
      }
      if (typeof window !== "undefined") {
        return window;
      }
      if (typeof global !== "undefined") {
        return global;
      }
      return {};
    }();
    function getWorkerBlob() {
      var URL2 = global.URL || global.webkitURL || null;
      var code = moduleFactory.toString();
      return Papa.BLOB_URL || (Papa.BLOB_URL = URL2.createObjectURL(new Blob(["var global = (function() { if (typeof self !== 'undefined') { return self; } if (typeof window !== 'undefined') { return window; } if (typeof global !== 'undefined') { return global; } return {}; })(); global.IS_PAPA_WORKER=true; ", "(", code, ")();"], { type: "text/javascript" })));
    }
    var IS_WORKER = !global.document && !!global.postMessage, IS_PAPA_WORKER = global.IS_PAPA_WORKER || false;
    var workers = {}, workerIdCounter = 0;
    var Papa = {};
    Papa.parse = CsvToJson;
    Papa.unparse = JsonToCsv;
    Papa.RECORD_SEP = String.fromCharCode(30);
    Papa.UNIT_SEP = String.fromCharCode(31);
    Papa.BYTE_ORDER_MARK = "\uFEFF";
    Papa.BAD_DELIMITERS = ["\r", `
`, '"', Papa.BYTE_ORDER_MARK];
    Papa.WORKERS_SUPPORTED = !IS_WORKER && !!global.Worker;
    Papa.NODE_STREAM_INPUT = 1;
    Papa.LocalChunkSize = 1024 * 1024 * 10;
    Papa.RemoteChunkSize = 1024 * 1024 * 5;
    Papa.DefaultDelimiter = ",";
    Papa.Parser = Parser;
    Papa.ParserHandle = ParserHandle;
    Papa.NetworkStreamer = NetworkStreamer;
    Papa.FileStreamer = FileStreamer;
    Papa.StringStreamer = StringStreamer;
    Papa.ReadableStreamStreamer = ReadableStreamStreamer;
    if (typeof PAPA_BROWSER_CONTEXT === "undefined") {
      Papa.DuplexStreamStreamer = DuplexStreamStreamer;
    }
    if (global.jQuery) {
      var $ = global.jQuery;
      $.fn.parse = function(options) {
        var config = options.config || {};
        var queue = [];
        this.each(function(idx) {
          var supported = $(this).prop("tagName").toUpperCase() === "INPUT" && $(this).attr("type").toLowerCase() === "file" && global.FileReader;
          if (!supported || !this.files || this.files.length === 0)
            return true;
          for (var i = 0;i < this.files.length; i++) {
            queue.push({
              file: this.files[i],
              inputElem: this,
              instanceConfig: $.extend({}, config)
            });
          }
        });
        parseNextFile();
        return this;
        function parseNextFile() {
          if (queue.length === 0) {
            if (isFunction(options.complete))
              options.complete();
            return;
          }
          var f = queue[0];
          if (isFunction(options.before)) {
            var returned = options.before(f.file, f.inputElem);
            if (typeof returned === "object") {
              if (returned.action === "abort") {
                error("AbortError", f.file, f.inputElem, returned.reason);
                return;
              } else if (returned.action === "skip") {
                fileComplete();
                return;
              } else if (typeof returned.config === "object")
                f.instanceConfig = $.extend(f.instanceConfig, returned.config);
            } else if (returned === "skip") {
              fileComplete();
              return;
            }
          }
          var userCompleteFunc = f.instanceConfig.complete;
          f.instanceConfig.complete = function(results) {
            if (isFunction(userCompleteFunc))
              userCompleteFunc(results, f.file, f.inputElem);
            fileComplete();
          };
          Papa.parse(f.file, f.instanceConfig);
        }
        function error(name, file, elem, reason) {
          if (isFunction(options.error))
            options.error({ name }, file, elem, reason);
        }
        function fileComplete() {
          queue.splice(0, 1);
          parseNextFile();
        }
      };
    }
    if (IS_PAPA_WORKER) {
      global.onmessage = workerThreadReceivedMessage;
    }
    function CsvToJson(_input, _config) {
      _config = _config || {};
      var dynamicTyping = _config.dynamicTyping || false;
      if (isFunction(dynamicTyping)) {
        _config.dynamicTypingFunction = dynamicTyping;
        dynamicTyping = {};
      }
      _config.dynamicTyping = dynamicTyping;
      _config.transform = isFunction(_config.transform) ? _config.transform : false;
      if (_config.worker && Papa.WORKERS_SUPPORTED) {
        var w = newWorker();
        w.userStep = _config.step;
        w.userChunk = _config.chunk;
        w.userComplete = _config.complete;
        w.userError = _config.error;
        _config.step = isFunction(_config.step);
        _config.chunk = isFunction(_config.chunk);
        _config.complete = isFunction(_config.complete);
        _config.error = isFunction(_config.error);
        delete _config.worker;
        w.postMessage({
          input: _input,
          config: _config,
          workerId: w.id
        });
        return;
      }
      var streamer = null;
      if (_input === Papa.NODE_STREAM_INPUT && typeof PAPA_BROWSER_CONTEXT === "undefined") {
        streamer = new DuplexStreamStreamer(_config);
        return streamer.getStream();
      } else if (typeof _input === "string") {
        _input = stripBom(_input);
        if (_config.download)
          streamer = new NetworkStreamer(_config);
        else
          streamer = new StringStreamer(_config);
      } else if (_input.readable === true && isFunction(_input.read) && isFunction(_input.on)) {
        streamer = new ReadableStreamStreamer(_config);
      } else if (global.File && _input instanceof File || _input instanceof Object)
        streamer = new FileStreamer(_config);
      return streamer.stream(_input);
      function stripBom(string) {
        if (string.charCodeAt(0) === 65279) {
          return string.slice(1);
        }
        return string;
      }
    }
    function JsonToCsv(_input, _config) {
      var _quotes = false;
      var _writeHeader = true;
      var _delimiter = ",";
      var _newline = `\r
`;
      var _quoteChar = '"';
      var _escapedQuote = _quoteChar + _quoteChar;
      var _skipEmptyLines = false;
      var _columns = null;
      var _escapeFormulae = false;
      unpackConfig();
      var quoteCharRegex = new RegExp(escapeRegExp(_quoteChar), "g");
      if (typeof _input === "string")
        _input = JSON.parse(_input);
      if (Array.isArray(_input)) {
        if (!_input.length || Array.isArray(_input[0]))
          return serialize(null, _input, _skipEmptyLines);
        else if (typeof _input[0] === "object")
          return serialize(_columns || Object.keys(_input[0]), _input, _skipEmptyLines);
      } else if (typeof _input === "object") {
        if (typeof _input.data === "string")
          _input.data = JSON.parse(_input.data);
        if (Array.isArray(_input.data)) {
          if (!_input.fields)
            _input.fields = _input.meta && _input.meta.fields || _columns;
          if (!_input.fields)
            _input.fields = Array.isArray(_input.data[0]) ? _input.fields : typeof _input.data[0] === "object" ? Object.keys(_input.data[0]) : [];
          if (!Array.isArray(_input.data[0]) && typeof _input.data[0] !== "object")
            _input.data = [_input.data];
        }
        return serialize(_input.fields || [], _input.data || [], _skipEmptyLines);
      }
      throw new Error("Unable to serialize unrecognized input");
      function unpackConfig() {
        if (typeof _config !== "object")
          return;
        if (typeof _config.delimiter === "string" && !Papa.BAD_DELIMITERS.filter(function(value) {
          return _config.delimiter.indexOf(value) !== -1;
        }).length) {
          _delimiter = _config.delimiter;
        }
        if (typeof _config.quotes === "boolean" || typeof _config.quotes === "function" || Array.isArray(_config.quotes))
          _quotes = _config.quotes;
        if (typeof _config.skipEmptyLines === "boolean" || typeof _config.skipEmptyLines === "string")
          _skipEmptyLines = _config.skipEmptyLines;
        if (typeof _config.newline === "string")
          _newline = _config.newline;
        if (typeof _config.quoteChar === "string")
          _quoteChar = _config.quoteChar;
        if (typeof _config.header === "boolean")
          _writeHeader = _config.header;
        if (Array.isArray(_config.columns)) {
          if (_config.columns.length === 0)
            throw new Error("Option columns is empty");
          _columns = _config.columns;
        }
        if (_config.escapeChar !== undefined) {
          _escapedQuote = _config.escapeChar + _quoteChar;
        }
        if (_config.escapeFormulae instanceof RegExp) {
          _escapeFormulae = _config.escapeFormulae;
        } else if (typeof _config.escapeFormulae === "boolean" && _config.escapeFormulae) {
          _escapeFormulae = /^[=+\-@\t\r].*$/;
        }
      }
      function serialize(fields, data, skipEmptyLines) {
        var csv = "";
        if (typeof fields === "string")
          fields = JSON.parse(fields);
        if (typeof data === "string")
          data = JSON.parse(data);
        var hasHeader = Array.isArray(fields) && fields.length > 0;
        var dataKeyedByField = !Array.isArray(data[0]);
        if (hasHeader && _writeHeader) {
          for (var i = 0;i < fields.length; i++) {
            if (i > 0)
              csv += _delimiter;
            csv += safe(fields[i], i);
          }
          if (data.length > 0)
            csv += _newline;
        }
        for (var row = 0;row < data.length; row++) {
          var maxCol = hasHeader ? fields.length : data[row].length;
          var emptyLine = false;
          var nullLine = hasHeader ? Object.keys(data[row]).length === 0 : data[row].length === 0;
          if (skipEmptyLines && !hasHeader) {
            emptyLine = skipEmptyLines === "greedy" ? data[row].join("").trim() === "" : data[row].length === 1 && data[row][0].length === 0;
          }
          if (skipEmptyLines === "greedy" && hasHeader) {
            var line = [];
            for (var c = 0;c < maxCol; c++) {
              var cx = dataKeyedByField ? fields[c] : c;
              line.push(data[row][cx]);
            }
            emptyLine = line.join("").trim() === "";
          }
          if (!emptyLine) {
            for (var col = 0;col < maxCol; col++) {
              if (col > 0 && !nullLine)
                csv += _delimiter;
              var colIdx = hasHeader && dataKeyedByField ? fields[col] : col;
              csv += safe(data[row][colIdx], col);
            }
            if (row < data.length - 1 && (!skipEmptyLines || maxCol > 0 && !nullLine)) {
              csv += _newline;
            }
          }
        }
        return csv;
      }
      function safe(str, col) {
        if (typeof str === "undefined" || str === null)
          return "";
        if (str.constructor === Date)
          return JSON.stringify(str).slice(1, 25);
        var needsQuotes = false;
        if (_escapeFormulae && typeof str === "string" && _escapeFormulae.test(str)) {
          str = "'" + str;
          needsQuotes = true;
        }
        var escapedQuoteStr = str.toString().replace(quoteCharRegex, _escapedQuote);
        needsQuotes = needsQuotes || _quotes === true || typeof _quotes === "function" && _quotes(str, col) || Array.isArray(_quotes) && _quotes[col] || hasAny(escapedQuoteStr, Papa.BAD_DELIMITERS) || escapedQuoteStr.indexOf(_delimiter) > -1 || escapedQuoteStr.charAt(0) === " " || escapedQuoteStr.charAt(escapedQuoteStr.length - 1) === " ";
        return needsQuotes ? _quoteChar + escapedQuoteStr + _quoteChar : escapedQuoteStr;
      }
      function hasAny(str, substrings) {
        for (var i = 0;i < substrings.length; i++)
          if (str.indexOf(substrings[i]) > -1)
            return true;
        return false;
      }
    }
    function ChunkStreamer(config) {
      this._handle = null;
      this._finished = false;
      this._completed = false;
      this._halted = false;
      this._input = null;
      this._baseIndex = 0;
      this._partialLine = "";
      this._rowCount = 0;
      this._start = 0;
      this._nextChunk = null;
      this.isFirstChunk = true;
      this._completeResults = {
        data: [],
        errors: [],
        meta: {}
      };
      replaceConfig.call(this, config);
      this.parseChunk = function(chunk, isFakeChunk) {
        const skipFirstNLines = parseInt(this._config.skipFirstNLines) || 0;
        if (this.isFirstChunk && skipFirstNLines > 0) {
          let _newline = this._config.newline;
          if (!_newline) {
            const quoteChar = this._config.quoteChar || '"';
            _newline = this._handle.guessLineEndings(chunk, quoteChar);
          }
          const splitChunk = chunk.split(_newline);
          chunk = [...splitChunk.slice(skipFirstNLines)].join(_newline);
        }
        if (this.isFirstChunk && isFunction(this._config.beforeFirstChunk)) {
          var modifiedChunk = this._config.beforeFirstChunk(chunk);
          if (modifiedChunk !== undefined)
            chunk = modifiedChunk;
        }
        this.isFirstChunk = false;
        this._halted = false;
        var aggregate = this._partialLine + chunk;
        this._partialLine = "";
        var results = this._handle.parse(aggregate, this._baseIndex, !this._finished);
        if (this._handle.paused() || this._handle.aborted()) {
          this._halted = true;
          return;
        }
        var lastIndex = results.meta.cursor;
        if (!this._finished) {
          this._partialLine = aggregate.substring(lastIndex - this._baseIndex);
          this._baseIndex = lastIndex;
        }
        if (results && results.data)
          this._rowCount += results.data.length;
        var finishedIncludingPreview = this._finished || this._config.preview && this._rowCount >= this._config.preview;
        if (IS_PAPA_WORKER) {
          global.postMessage({
            results,
            workerId: Papa.WORKER_ID,
            finished: finishedIncludingPreview
          });
        } else if (isFunction(this._config.chunk) && !isFakeChunk) {
          this._config.chunk(results, this._handle);
          if (this._handle.paused() || this._handle.aborted()) {
            this._halted = true;
            return;
          }
          results = undefined;
          this._completeResults = undefined;
        }
        if (!this._config.step && !this._config.chunk) {
          this._completeResults.data = this._completeResults.data.concat(results.data);
          this._completeResults.errors = this._completeResults.errors.concat(results.errors);
          this._completeResults.meta = results.meta;
        }
        if (!this._completed && finishedIncludingPreview && isFunction(this._config.complete) && (!results || !results.meta.aborted)) {
          this._config.complete(this._completeResults, this._input);
          this._completed = true;
        }
        if (!finishedIncludingPreview && (!results || !results.meta.paused))
          this._nextChunk();
        return results;
      };
      this._sendError = function(error) {
        if (isFunction(this._config.error))
          this._config.error(error);
        else if (IS_PAPA_WORKER && this._config.error) {
          global.postMessage({
            workerId: Papa.WORKER_ID,
            error,
            finished: false
          });
        }
      };
      function replaceConfig(config2) {
        var configCopy = copy(config2);
        configCopy.chunkSize = parseInt(configCopy.chunkSize);
        if (!config2.step && !config2.chunk)
          configCopy.chunkSize = null;
        this._handle = new ParserHandle(configCopy);
        this._handle.streamer = this;
        this._config = configCopy;
      }
    }
    function NetworkStreamer(config) {
      config = config || {};
      if (!config.chunkSize)
        config.chunkSize = Papa.RemoteChunkSize;
      ChunkStreamer.call(this, config);
      var xhr;
      if (IS_WORKER) {
        this._nextChunk = function() {
          this._readChunk();
          this._chunkLoaded();
        };
      } else {
        this._nextChunk = function() {
          this._readChunk();
        };
      }
      this.stream = function(url) {
        this._input = url;
        this._nextChunk();
      };
      this._readChunk = function() {
        if (this._finished) {
          this._chunkLoaded();
          return;
        }
        xhr = new XMLHttpRequest;
        if (this._config.withCredentials) {
          xhr.withCredentials = this._config.withCredentials;
        }
        if (!IS_WORKER) {
          xhr.onload = bindFunction(this._chunkLoaded, this);
          xhr.onerror = bindFunction(this._chunkError, this);
        }
        xhr.open(this._config.downloadRequestBody ? "POST" : "GET", this._input, !IS_WORKER);
        if (this._config.downloadRequestHeaders) {
          var headers = this._config.downloadRequestHeaders;
          for (var headerName in headers) {
            xhr.setRequestHeader(headerName, headers[headerName]);
          }
        }
        if (this._config.chunkSize) {
          var end = this._start + this._config.chunkSize - 1;
          xhr.setRequestHeader("Range", "bytes=" + this._start + "-" + end);
        }
        try {
          xhr.send(this._config.downloadRequestBody);
        } catch (err) {
          this._chunkError(err.message);
        }
        if (IS_WORKER && xhr.status === 0)
          this._chunkError();
      };
      this._chunkLoaded = function() {
        if (xhr.readyState !== 4)
          return;
        if (xhr.status < 200 || xhr.status >= 400) {
          this._chunkError();
          return;
        }
        this._start += this._config.chunkSize ? this._config.chunkSize : xhr.responseText.length;
        this._finished = !this._config.chunkSize || this._start >= getFileSize(xhr);
        this.parseChunk(xhr.responseText);
      };
      this._chunkError = function(errorMessage) {
        var errorText = xhr.statusText || errorMessage;
        this._sendError(new Error(errorText));
      };
      function getFileSize(xhr2) {
        var contentRange = xhr2.getResponseHeader("Content-Range");
        if (contentRange === null) {
          return -1;
        }
        return parseInt(contentRange.substring(contentRange.lastIndexOf("/") + 1));
      }
    }
    NetworkStreamer.prototype = Object.create(ChunkStreamer.prototype);
    NetworkStreamer.prototype.constructor = NetworkStreamer;
    function FileStreamer(config) {
      config = config || {};
      if (!config.chunkSize)
        config.chunkSize = Papa.LocalChunkSize;
      ChunkStreamer.call(this, config);
      var reader, slice;
      var usingAsyncReader = typeof FileReader !== "undefined";
      this.stream = function(file) {
        this._input = file;
        slice = file.slice || file.webkitSlice || file.mozSlice;
        if (usingAsyncReader) {
          reader = new FileReader;
          reader.onload = bindFunction(this._chunkLoaded, this);
          reader.onerror = bindFunction(this._chunkError, this);
        } else
          reader = new FileReaderSync;
        this._nextChunk();
      };
      this._nextChunk = function() {
        if (!this._finished && (!this._config.preview || this._rowCount < this._config.preview))
          this._readChunk();
      };
      this._readChunk = function() {
        var input = this._input;
        if (this._config.chunkSize) {
          var end = Math.min(this._start + this._config.chunkSize, this._input.size);
          input = slice.call(input, this._start, end);
        }
        var txt = reader.readAsText(input, this._config.encoding);
        if (!usingAsyncReader)
          this._chunkLoaded({ target: { result: txt } });
      };
      this._chunkLoaded = function(event) {
        this._start += this._config.chunkSize;
        this._finished = !this._config.chunkSize || this._start >= this._input.size;
        this.parseChunk(event.target.result);
      };
      this._chunkError = function() {
        this._sendError(reader.error);
      };
    }
    FileStreamer.prototype = Object.create(ChunkStreamer.prototype);
    FileStreamer.prototype.constructor = FileStreamer;
    function StringStreamer(config) {
      config = config || {};
      ChunkStreamer.call(this, config);
      var remaining;
      this.stream = function(s) {
        remaining = s;
        return this._nextChunk();
      };
      this._nextChunk = function() {
        if (this._finished)
          return;
        var size = this._config.chunkSize;
        var chunk;
        if (size) {
          chunk = remaining.substring(0, size);
          remaining = remaining.substring(size);
        } else {
          chunk = remaining;
          remaining = "";
        }
        this._finished = !remaining;
        return this.parseChunk(chunk);
      };
    }
    StringStreamer.prototype = Object.create(StringStreamer.prototype);
    StringStreamer.prototype.constructor = StringStreamer;
    function ReadableStreamStreamer(config) {
      config = config || {};
      ChunkStreamer.call(this, config);
      var queue = [];
      var parseOnData = true;
      var streamHasEnded = false;
      this.pause = function() {
        ChunkStreamer.prototype.pause.apply(this, arguments);
        this._input.pause();
      };
      this.resume = function() {
        ChunkStreamer.prototype.resume.apply(this, arguments);
        this._input.resume();
      };
      this.stream = function(stream) {
        this._input = stream;
        this._input.on("data", this._streamData);
        this._input.on("end", this._streamEnd);
        this._input.on("error", this._streamError);
      };
      this._checkIsFinished = function() {
        if (streamHasEnded && queue.length === 1) {
          this._finished = true;
        }
      };
      this._nextChunk = function() {
        this._checkIsFinished();
        if (queue.length) {
          this.parseChunk(queue.shift());
        } else {
          parseOnData = true;
        }
      };
      this._streamData = bindFunction(function(chunk) {
        try {
          queue.push(typeof chunk === "string" ? chunk : chunk.toString(this._config.encoding));
          if (parseOnData) {
            parseOnData = false;
            this._checkIsFinished();
            this.parseChunk(queue.shift());
          }
        } catch (error) {
          this._streamError(error);
        }
      }, this);
      this._streamError = bindFunction(function(error) {
        this._streamCleanUp();
        this._sendError(error);
      }, this);
      this._streamEnd = bindFunction(function() {
        this._streamCleanUp();
        streamHasEnded = true;
        this._streamData("");
      }, this);
      this._streamCleanUp = bindFunction(function() {
        this._input.removeListener("data", this._streamData);
        this._input.removeListener("end", this._streamEnd);
        this._input.removeListener("error", this._streamError);
      }, this);
    }
    ReadableStreamStreamer.prototype = Object.create(ChunkStreamer.prototype);
    ReadableStreamStreamer.prototype.constructor = ReadableStreamStreamer;
    function DuplexStreamStreamer(_config) {
      var Duplex = __require("stream").Duplex;
      var config = copy(_config);
      var parseOnWrite = true;
      var writeStreamHasFinished = false;
      var parseCallbackQueue = [];
      var stream = null;
      this._onCsvData = function(results) {
        var data = results.data;
        if (!stream.push(data) && !this._handle.paused()) {
          this._handle.pause();
        }
      };
      this._onCsvComplete = function() {
        stream.push(null);
      };
      config.step = bindFunction(this._onCsvData, this);
      config.complete = bindFunction(this._onCsvComplete, this);
      ChunkStreamer.call(this, config);
      this._nextChunk = function() {
        if (writeStreamHasFinished && parseCallbackQueue.length === 1) {
          this._finished = true;
        }
        if (parseCallbackQueue.length) {
          parseCallbackQueue.shift()();
        } else {
          parseOnWrite = true;
        }
      };
      this._addToParseQueue = function(chunk, callback) {
        parseCallbackQueue.push(bindFunction(function() {
          this.parseChunk(typeof chunk === "string" ? chunk : chunk.toString(config.encoding));
          if (isFunction(callback)) {
            return callback();
          }
        }, this));
        if (parseOnWrite) {
          parseOnWrite = false;
          this._nextChunk();
        }
      };
      this._onRead = function() {
        if (this._handle.paused()) {
          this._handle.resume();
        }
      };
      this._onWrite = function(chunk, encoding, callback) {
        this._addToParseQueue(chunk, callback);
      };
      this._onWriteComplete = function() {
        writeStreamHasFinished = true;
        this._addToParseQueue("");
      };
      this.getStream = function() {
        return stream;
      };
      stream = new Duplex({
        readableObjectMode: true,
        decodeStrings: false,
        read: bindFunction(this._onRead, this),
        write: bindFunction(this._onWrite, this)
      });
      stream.once("finish", bindFunction(this._onWriteComplete, this));
    }
    if (typeof PAPA_BROWSER_CONTEXT === "undefined") {
      DuplexStreamStreamer.prototype = Object.create(ChunkStreamer.prototype);
      DuplexStreamStreamer.prototype.constructor = DuplexStreamStreamer;
    }
    function ParserHandle(_config) {
      var MAX_FLOAT = Math.pow(2, 53);
      var MIN_FLOAT = -MAX_FLOAT;
      var FLOAT = /^\s*-?(\d+\.?|\.\d+|\d+\.\d+)([eE][-+]?\d+)?\s*$/;
      var ISO_DATE = /^((\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z)))$/;
      var self2 = this;
      var _stepCounter = 0;
      var _rowCounter = 0;
      var _input;
      var _parser;
      var _paused = false;
      var _aborted = false;
      var _delimiterError;
      var _fields = [];
      var _results = {
        data: [],
        errors: [],
        meta: {}
      };
      if (isFunction(_config.step)) {
        var userStep = _config.step;
        _config.step = function(results) {
          _results = results;
          if (needsHeaderRow())
            processResults();
          else {
            processResults();
            if (_results.data.length === 0)
              return;
            _stepCounter += results.data.length;
            if (_config.preview && _stepCounter > _config.preview)
              _parser.abort();
            else {
              _results.data = _results.data[0];
              userStep(_results, self2);
            }
          }
        };
      }
      this.parse = function(input, baseIndex, ignoreLastRow) {
        var quoteChar = _config.quoteChar || '"';
        if (!_config.newline)
          _config.newline = this.guessLineEndings(input, quoteChar);
        _delimiterError = false;
        if (!_config.delimiter) {
          var delimGuess = guessDelimiter(input, _config.newline, _config.skipEmptyLines, _config.comments, _config.delimitersToGuess);
          if (delimGuess.successful)
            _config.delimiter = delimGuess.bestDelimiter;
          else {
            _delimiterError = true;
            _config.delimiter = Papa.DefaultDelimiter;
          }
          _results.meta.delimiter = _config.delimiter;
        } else if (isFunction(_config.delimiter)) {
          _config.delimiter = _config.delimiter(input);
          _results.meta.delimiter = _config.delimiter;
        }
        var parserConfig = copy(_config);
        if (_config.preview && _config.header)
          parserConfig.preview++;
        _input = input;
        _parser = new Parser(parserConfig);
        _results = _parser.parse(_input, baseIndex, ignoreLastRow);
        processResults();
        return _paused ? { meta: { paused: true } } : _results || { meta: { paused: false } };
      };
      this.paused = function() {
        return _paused;
      };
      this.pause = function() {
        _paused = true;
        _parser.abort();
        _input = isFunction(_config.chunk) ? "" : _input.substring(_parser.getCharIndex());
      };
      this.resume = function() {
        if (self2.streamer._halted) {
          _paused = false;
          self2.streamer.parseChunk(_input, true);
        } else {
          setTimeout(self2.resume, 3);
        }
      };
      this.aborted = function() {
        return _aborted;
      };
      this.abort = function() {
        _aborted = true;
        _parser.abort();
        _results.meta.aborted = true;
        if (isFunction(_config.complete))
          _config.complete(_results);
        _input = "";
      };
      this.guessLineEndings = function(input, quoteChar) {
        input = input.substring(0, 1024 * 1024);
        var re = new RegExp(escapeRegExp(quoteChar) + "([^]*?)" + escapeRegExp(quoteChar), "gm");
        input = input.replace(re, "");
        var r = input.split("\r");
        var n = input.split(`
`);
        var nAppearsFirst = n.length > 1 && n[0].length < r[0].length;
        if (r.length === 1 || nAppearsFirst)
          return `
`;
        var numWithN = 0;
        for (var i = 0;i < r.length; i++) {
          if (r[i][0] === `
`)
            numWithN++;
        }
        return numWithN >= r.length / 2 ? `\r
` : "\r";
      };
      function testEmptyLine(s) {
        return _config.skipEmptyLines === "greedy" ? s.join("").trim() === "" : s.length === 1 && s[0].length === 0;
      }
      function testFloat(s) {
        if (FLOAT.test(s)) {
          var floatValue = parseFloat(s);
          if (floatValue > MIN_FLOAT && floatValue < MAX_FLOAT) {
            return true;
          }
        }
        return false;
      }
      function processResults() {
        if (_results && _delimiterError) {
          addError("Delimiter", "UndetectableDelimiter", "Unable to auto-detect delimiting character; defaulted to '" + Papa.DefaultDelimiter + "'");
          _delimiterError = false;
        }
        if (_config.skipEmptyLines) {
          _results.data = _results.data.filter(function(d) {
            return !testEmptyLine(d);
          });
        }
        if (needsHeaderRow())
          fillHeaderFields();
        return applyHeaderAndDynamicTypingAndTransformation();
      }
      function needsHeaderRow() {
        return _config.header && _fields.length === 0;
      }
      function fillHeaderFields() {
        if (!_results)
          return;
        function addHeader(header, i2) {
          if (isFunction(_config.transformHeader))
            header = _config.transformHeader(header, i2);
          _fields.push(header);
        }
        if (Array.isArray(_results.data[0])) {
          for (var i = 0;needsHeaderRow() && i < _results.data.length; i++)
            _results.data[i].forEach(addHeader);
          _results.data.splice(0, 1);
        } else
          _results.data.forEach(addHeader);
      }
      function shouldApplyDynamicTyping(field) {
        if (_config.dynamicTypingFunction && _config.dynamicTyping[field] === undefined) {
          _config.dynamicTyping[field] = _config.dynamicTypingFunction(field);
        }
        return (_config.dynamicTyping[field] || _config.dynamicTyping) === true;
      }
      function parseDynamic(field, value) {
        if (shouldApplyDynamicTyping(field)) {
          if (value === "true" || value === "TRUE")
            return true;
          else if (value === "false" || value === "FALSE")
            return false;
          else if (testFloat(value))
            return parseFloat(value);
          else if (ISO_DATE.test(value))
            return new Date(value);
          else
            return value === "" ? null : value;
        }
        return value;
      }
      function applyHeaderAndDynamicTypingAndTransformation() {
        if (!_results || !_config.header && !_config.dynamicTyping && !_config.transform)
          return _results;
        function processRow(rowSource, i) {
          var row = _config.header ? {} : [];
          var j;
          for (j = 0;j < rowSource.length; j++) {
            var field = j;
            var value = rowSource[j];
            if (_config.header)
              field = j >= _fields.length ? "__parsed_extra" : _fields[j];
            if (_config.transform)
              value = _config.transform(value, field);
            value = parseDynamic(field, value);
            if (field === "__parsed_extra") {
              row[field] = row[field] || [];
              row[field].push(value);
            } else
              row[field] = value;
          }
          if (_config.header) {
            if (j > _fields.length)
              addError("FieldMismatch", "TooManyFields", "Too many fields: expected " + _fields.length + " fields but parsed " + j, _rowCounter + i);
            else if (j < _fields.length)
              addError("FieldMismatch", "TooFewFields", "Too few fields: expected " + _fields.length + " fields but parsed " + j, _rowCounter + i);
          }
          return row;
        }
        var incrementBy = 1;
        if (!_results.data.length || Array.isArray(_results.data[0])) {
          _results.data = _results.data.map(processRow);
          incrementBy = _results.data.length;
        } else
          _results.data = processRow(_results.data, 0);
        if (_config.header && _results.meta)
          _results.meta.fields = _fields;
        _rowCounter += incrementBy;
        return _results;
      }
      function guessDelimiter(input, newline, skipEmptyLines, comments, delimitersToGuess) {
        var bestDelim, bestDelta, fieldCountPrevRow, maxFieldCount;
        delimitersToGuess = delimitersToGuess || [",", "\t", "|", ";", Papa.RECORD_SEP, Papa.UNIT_SEP];
        for (var i = 0;i < delimitersToGuess.length; i++) {
          var delim = delimitersToGuess[i];
          var delta = 0, avgFieldCount = 0, emptyLinesCount = 0;
          fieldCountPrevRow = undefined;
          var preview = new Parser({
            comments,
            delimiter: delim,
            newline,
            preview: 10
          }).parse(input);
          for (var j = 0;j < preview.data.length; j++) {
            if (skipEmptyLines && testEmptyLine(preview.data[j])) {
              emptyLinesCount++;
              continue;
            }
            var fieldCount = preview.data[j].length;
            avgFieldCount += fieldCount;
            if (typeof fieldCountPrevRow === "undefined") {
              fieldCountPrevRow = fieldCount;
              continue;
            } else if (fieldCount > 0) {
              delta += Math.abs(fieldCount - fieldCountPrevRow);
              fieldCountPrevRow = fieldCount;
            }
          }
          if (preview.data.length > 0)
            avgFieldCount /= preview.data.length - emptyLinesCount;
          if ((typeof bestDelta === "undefined" || delta <= bestDelta) && (typeof maxFieldCount === "undefined" || avgFieldCount > maxFieldCount) && avgFieldCount > 1.99) {
            bestDelta = delta;
            bestDelim = delim;
            maxFieldCount = avgFieldCount;
          }
        }
        _config.delimiter = bestDelim;
        return {
          successful: !!bestDelim,
          bestDelimiter: bestDelim
        };
      }
      function addError(type, code, msg, row) {
        var error = {
          type,
          code,
          message: msg
        };
        if (row !== undefined) {
          error.row = row;
        }
        _results.errors.push(error);
      }
    }
    function escapeRegExp(string) {
      return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    function Parser(config) {
      config = config || {};
      var delim = config.delimiter;
      var newline = config.newline;
      var comments = config.comments;
      var step = config.step;
      var preview = config.preview;
      var fastMode = config.fastMode;
      var quoteChar;
      var renamedHeaders = null;
      var headerParsed = false;
      if (config.quoteChar === undefined || config.quoteChar === null) {
        quoteChar = '"';
      } else {
        quoteChar = config.quoteChar;
      }
      var escapeChar = quoteChar;
      if (config.escapeChar !== undefined) {
        escapeChar = config.escapeChar;
      }
      if (typeof delim !== "string" || Papa.BAD_DELIMITERS.indexOf(delim) > -1)
        delim = ",";
      if (comments === delim)
        throw new Error("Comment character same as delimiter");
      else if (comments === true)
        comments = "#";
      else if (typeof comments !== "string" || Papa.BAD_DELIMITERS.indexOf(comments) > -1)
        comments = false;
      if (newline !== `
` && newline !== "\r" && newline !== `\r
`)
        newline = `
`;
      var cursor = 0;
      var aborted = false;
      this.parse = function(input, baseIndex, ignoreLastRow) {
        if (typeof input !== "string")
          throw new Error("Input must be a string");
        var inputLen = input.length, delimLen = delim.length, newlineLen = newline.length, commentsLen = comments.length;
        var stepIsFunction = isFunction(step);
        cursor = 0;
        var data = [], errors = [], row = [], lastCursor = 0;
        if (!input)
          return returnable();
        if (fastMode || fastMode !== false && input.indexOf(quoteChar) === -1) {
          var rows = input.split(newline);
          for (var i = 0;i < rows.length; i++) {
            row = rows[i];
            cursor += row.length;
            if (i !== rows.length - 1)
              cursor += newline.length;
            else if (ignoreLastRow)
              return returnable();
            if (comments && row.substring(0, commentsLen) === comments)
              continue;
            if (stepIsFunction) {
              data = [];
              pushRow(row.split(delim));
              doStep();
              if (aborted)
                return returnable();
            } else
              pushRow(row.split(delim));
            if (preview && i >= preview) {
              data = data.slice(0, preview);
              return returnable(true);
            }
          }
          return returnable();
        }
        var nextDelim = input.indexOf(delim, cursor);
        var nextNewline = input.indexOf(newline, cursor);
        var quoteCharRegex = new RegExp(escapeRegExp(escapeChar) + escapeRegExp(quoteChar), "g");
        var quoteSearch = input.indexOf(quoteChar, cursor);
        for (;; ) {
          if (input[cursor] === quoteChar) {
            quoteSearch = cursor;
            cursor++;
            for (;; ) {
              quoteSearch = input.indexOf(quoteChar, quoteSearch + 1);
              if (quoteSearch === -1) {
                if (!ignoreLastRow) {
                  errors.push({
                    type: "Quotes",
                    code: "MissingQuotes",
                    message: "Quoted field unterminated",
                    row: data.length,
                    index: cursor
                  });
                }
                return finish();
              }
              if (quoteSearch === inputLen - 1) {
                var value = input.substring(cursor, quoteSearch).replace(quoteCharRegex, quoteChar);
                return finish(value);
              }
              if (quoteChar === escapeChar && input[quoteSearch + 1] === escapeChar) {
                quoteSearch++;
                continue;
              }
              if (quoteChar !== escapeChar && quoteSearch !== 0 && input[quoteSearch - 1] === escapeChar) {
                continue;
              }
              if (nextDelim !== -1 && nextDelim < quoteSearch + 1) {
                nextDelim = input.indexOf(delim, quoteSearch + 1);
              }
              if (nextNewline !== -1 && nextNewline < quoteSearch + 1) {
                nextNewline = input.indexOf(newline, quoteSearch + 1);
              }
              var checkUpTo = nextNewline === -1 ? nextDelim : Math.min(nextDelim, nextNewline);
              var spacesBetweenQuoteAndDelimiter = extraSpaces(checkUpTo);
              if (input.substr(quoteSearch + 1 + spacesBetweenQuoteAndDelimiter, delimLen) === delim) {
                row.push(input.substring(cursor, quoteSearch).replace(quoteCharRegex, quoteChar));
                cursor = quoteSearch + 1 + spacesBetweenQuoteAndDelimiter + delimLen;
                if (input[quoteSearch + 1 + spacesBetweenQuoteAndDelimiter + delimLen] !== quoteChar) {
                  quoteSearch = input.indexOf(quoteChar, cursor);
                }
                nextDelim = input.indexOf(delim, cursor);
                nextNewline = input.indexOf(newline, cursor);
                break;
              }
              var spacesBetweenQuoteAndNewLine = extraSpaces(nextNewline);
              if (input.substring(quoteSearch + 1 + spacesBetweenQuoteAndNewLine, quoteSearch + 1 + spacesBetweenQuoteAndNewLine + newlineLen) === newline) {
                row.push(input.substring(cursor, quoteSearch).replace(quoteCharRegex, quoteChar));
                saveRow(quoteSearch + 1 + spacesBetweenQuoteAndNewLine + newlineLen);
                nextDelim = input.indexOf(delim, cursor);
                quoteSearch = input.indexOf(quoteChar, cursor);
                if (stepIsFunction) {
                  doStep();
                  if (aborted)
                    return returnable();
                }
                if (preview && data.length >= preview)
                  return returnable(true);
                break;
              }
              errors.push({
                type: "Quotes",
                code: "InvalidQuotes",
                message: "Trailing quote on quoted field is malformed",
                row: data.length,
                index: cursor
              });
              quoteSearch++;
              continue;
            }
            continue;
          }
          if (comments && row.length === 0 && input.substring(cursor, cursor + commentsLen) === comments) {
            if (nextNewline === -1)
              return returnable();
            cursor = nextNewline + newlineLen;
            nextNewline = input.indexOf(newline, cursor);
            nextDelim = input.indexOf(delim, cursor);
            continue;
          }
          if (nextDelim !== -1 && (nextDelim < nextNewline || nextNewline === -1)) {
            row.push(input.substring(cursor, nextDelim));
            cursor = nextDelim + delimLen;
            nextDelim = input.indexOf(delim, cursor);
            continue;
          }
          if (nextNewline !== -1) {
            row.push(input.substring(cursor, nextNewline));
            saveRow(nextNewline + newlineLen);
            if (stepIsFunction) {
              doStep();
              if (aborted)
                return returnable();
            }
            if (preview && data.length >= preview)
              return returnable(true);
            continue;
          }
          break;
        }
        return finish();
        function pushRow(row2) {
          data.push(row2);
          lastCursor = cursor;
        }
        function extraSpaces(index) {
          var spaceLength = 0;
          if (index !== -1) {
            var textBetweenClosingQuoteAndIndex = input.substring(quoteSearch + 1, index);
            if (textBetweenClosingQuoteAndIndex && textBetweenClosingQuoteAndIndex.trim() === "") {
              spaceLength = textBetweenClosingQuoteAndIndex.length;
            }
          }
          return spaceLength;
        }
        function finish(value2) {
          if (ignoreLastRow)
            return returnable();
          if (typeof value2 === "undefined")
            value2 = input.substring(cursor);
          row.push(value2);
          cursor = inputLen;
          pushRow(row);
          if (stepIsFunction)
            doStep();
          return returnable();
        }
        function saveRow(newCursor) {
          cursor = newCursor;
          pushRow(row);
          row = [];
          nextNewline = input.indexOf(newline, cursor);
        }
        function returnable(stopped) {
          if (config.header && !baseIndex && data.length && !headerParsed) {
            const result = data[0];
            const headerCount = Object.create(null);
            const usedHeaders = new Set(result);
            let duplicateHeaders = false;
            for (let i2 = 0;i2 < result.length; i2++) {
              let header = result[i2];
              if (isFunction(config.transformHeader))
                header = config.transformHeader(header, i2);
              if (!headerCount[header]) {
                headerCount[header] = 1;
                result[i2] = header;
              } else {
                let newHeader;
                let suffixCount = headerCount[header];
                do {
                  newHeader = `${header}_${suffixCount}`;
                  suffixCount++;
                } while (usedHeaders.has(newHeader));
                usedHeaders.add(newHeader);
                result[i2] = newHeader;
                headerCount[header]++;
                duplicateHeaders = true;
                if (renamedHeaders === null) {
                  renamedHeaders = {};
                }
                renamedHeaders[newHeader] = header;
              }
              usedHeaders.add(header);
            }
            if (duplicateHeaders) {
              console.warn("Duplicate headers found and renamed.");
            }
            headerParsed = true;
          }
          return {
            data,
            errors,
            meta: {
              delimiter: delim,
              linebreak: newline,
              aborted,
              truncated: !!stopped,
              cursor: lastCursor + (baseIndex || 0),
              renamedHeaders
            }
          };
        }
        function doStep() {
          step(returnable());
          data = [];
          errors = [];
        }
      };
      this.abort = function() {
        aborted = true;
      };
      this.getCharIndex = function() {
        return cursor;
      };
    }
    function newWorker() {
      if (!Papa.WORKERS_SUPPORTED)
        return false;
      var workerUrl = getWorkerBlob();
      var w = new global.Worker(workerUrl);
      w.onmessage = mainThreadReceivedMessage;
      w.id = workerIdCounter++;
      workers[w.id] = w;
      return w;
    }
    function mainThreadReceivedMessage(e) {
      var msg = e.data;
      var worker = workers[msg.workerId];
      var aborted = false;
      if (msg.error)
        worker.userError(msg.error, msg.file);
      else if (msg.results && msg.results.data) {
        var abort = function() {
          aborted = true;
          completeWorker(msg.workerId, { data: [], errors: [], meta: { aborted: true } });
        };
        var handle = {
          abort,
          pause: notImplemented,
          resume: notImplemented
        };
        if (isFunction(worker.userStep)) {
          for (var i = 0;i < msg.results.data.length; i++) {
            worker.userStep({
              data: msg.results.data[i],
              errors: msg.results.errors,
              meta: msg.results.meta
            }, handle);
            if (aborted)
              break;
          }
          delete msg.results;
        } else if (isFunction(worker.userChunk)) {
          worker.userChunk(msg.results, handle, msg.file);
          delete msg.results;
        }
      }
      if (msg.finished && !aborted)
        completeWorker(msg.workerId, msg.results);
    }
    function completeWorker(workerId, results) {
      var worker = workers[workerId];
      if (isFunction(worker.userComplete))
        worker.userComplete(results);
      worker.terminate();
      delete workers[workerId];
    }
    function notImplemented() {
      throw new Error("Not implemented.");
    }
    function workerThreadReceivedMessage(e) {
      var msg = e.data;
      if (typeof Papa.WORKER_ID === "undefined" && msg)
        Papa.WORKER_ID = msg.workerId;
      if (typeof msg.input === "string") {
        global.postMessage({
          workerId: Papa.WORKER_ID,
          results: Papa.parse(msg.input, msg.config),
          finished: true
        });
      } else if (global.File && msg.input instanceof File || msg.input instanceof Object) {
        var results = Papa.parse(msg.input, msg.config);
        if (results)
          global.postMessage({
            workerId: Papa.WORKER_ID,
            results,
            finished: true
          });
      }
    }
    function copy(obj) {
      if (typeof obj !== "object" || obj === null)
        return obj;
      var cpy = Array.isArray(obj) ? [] : {};
      for (var key in obj)
        cpy[key] = copy(obj[key]);
      return cpy;
    }
    function bindFunction(f, self2) {
      return function() {
        f.apply(self2, arguments);
      };
    }
    function isFunction(func) {
      return typeof func === "function";
    }
    return Papa;
  });
});

// ../node_modules/cli-table3/src/debug.js
var require_debug = __commonJS((exports, module) => {
  var messages = [];
  var level = 0;
  var debug = (msg, min) => {
    if (level >= min) {
      messages.push(msg);
    }
  };
  debug.WARN = 1;
  debug.INFO = 2;
  debug.DEBUG = 3;
  debug.reset = () => {
    messages = [];
  };
  debug.setDebugLevel = (v) => {
    level = v;
  };
  debug.warn = (msg) => debug(msg, debug.WARN);
  debug.info = (msg) => debug(msg, debug.INFO);
  debug.debug = (msg) => debug(msg, debug.DEBUG);
  debug.debugMessages = () => messages;
  module.exports = debug;
});

// ../node_modules/ansi-regex/index.js
var require_ansi_regex = __commonJS((exports, module) => {
  module.exports = ({ onlyFirst = false } = {}) => {
    const pattern = [
      "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)",
      "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))"
    ].join("|");
    return new RegExp(pattern, onlyFirst ? undefined : "g");
  };
});

// ../node_modules/strip-ansi/index.js
var require_strip_ansi = __commonJS((exports, module) => {
  var ansiRegex = require_ansi_regex();
  module.exports = (string) => typeof string === "string" ? string.replace(ansiRegex(), "") : string;
});

// ../node_modules/is-fullwidth-code-point/index.js
var require_is_fullwidth_code_point = __commonJS((exports, module) => {
  var isFullwidthCodePoint = (codePoint) => {
    if (Number.isNaN(codePoint)) {
      return false;
    }
    if (codePoint >= 4352 && (codePoint <= 4447 || codePoint === 9001 || codePoint === 9002 || 11904 <= codePoint && codePoint <= 12871 && codePoint !== 12351 || 12880 <= codePoint && codePoint <= 19903 || 19968 <= codePoint && codePoint <= 42182 || 43360 <= codePoint && codePoint <= 43388 || 44032 <= codePoint && codePoint <= 55203 || 63744 <= codePoint && codePoint <= 64255 || 65040 <= codePoint && codePoint <= 65049 || 65072 <= codePoint && codePoint <= 65131 || 65281 <= codePoint && codePoint <= 65376 || 65504 <= codePoint && codePoint <= 65510 || 110592 <= codePoint && codePoint <= 110593 || 127488 <= codePoint && codePoint <= 127569 || 131072 <= codePoint && codePoint <= 262141)) {
      return true;
    }
    return false;
  };
  module.exports = isFullwidthCodePoint;
  module.exports.default = isFullwidthCodePoint;
});

// ../node_modules/string-width/node_modules/emoji-regex/index.js
var require_emoji_regex = __commonJS((exports, module) => {
  module.exports = function() {
    return /\uD83C\uDFF4\uDB40\uDC67\uDB40\uDC62(?:\uDB40\uDC65\uDB40\uDC6E\uDB40\uDC67|\uDB40\uDC73\uDB40\uDC63\uDB40\uDC74|\uDB40\uDC77\uDB40\uDC6C\uDB40\uDC73)\uDB40\uDC7F|\uD83D\uDC68(?:\uD83C\uDFFC\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68\uD83C\uDFFB|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFF\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFE])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFE\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFD])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFD\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB\uDFFC])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\u200D(?:\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83D\uDC68|(?:\uD83D[\uDC68\uDC69])\u200D(?:\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67]))|\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67])|(?:\uD83D[\uDC68\uDC69])\u200D(?:\uD83D[\uDC66\uDC67])|[\u2695\u2696\u2708]\uFE0F|\uD83D[\uDC66\uDC67]|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|(?:\uD83C\uDFFB\u200D[\u2695\u2696\u2708]|\uD83C\uDFFF\u200D[\u2695\u2696\u2708]|\uD83C\uDFFE\u200D[\u2695\u2696\u2708]|\uD83C\uDFFD\u200D[\u2695\u2696\u2708]|\uD83C\uDFFC\u200D[\u2695\u2696\u2708])\uFE0F|\uD83C\uDFFB\u200D(?:\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C[\uDFFB-\uDFFF])|(?:\uD83E\uDDD1\uD83C\uDFFB\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFC\u200D\uD83E\uDD1D\u200D\uD83D\uDC69)\uD83C\uDFFB|\uD83E\uDDD1(?:\uD83C\uDFFF\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1(?:\uD83C[\uDFFB-\uDFFF])|\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1)|(?:\uD83E\uDDD1\uD83C\uDFFE\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFF\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFB-\uDFFE])|(?:\uD83E\uDDD1\uD83C\uDFFC\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFD\u200D\uD83E\uDD1D\u200D\uD83D\uDC69)(?:\uD83C[\uDFFB\uDFFC])|\uD83D\uDC69(?:\uD83C\uDFFE\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFD\uDFFF])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFC\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB\uDFFD-\uDFFF])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFB\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFC-\uDFFF])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFD\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\u200D(?:\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D(?:\uD83D[\uDC68\uDC69])|\uD83D[\uDC68\uDC69])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFF\u200D(?:\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD]))|\uD83D\uDC69\u200D\uD83D\uDC69\u200D(?:\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67]))|(?:\uD83E\uDDD1\uD83C\uDFFD\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFE\u200D\uD83E\uDD1D\u200D\uD83D\uDC69)(?:\uD83C[\uDFFB-\uDFFD])|\uD83D\uDC69\u200D\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC69\u200D\uD83D\uDC69\u200D(?:\uD83D[\uDC66\uDC67])|(?:\uD83D\uDC41\uFE0F\u200D\uD83D\uDDE8|\uD83D\uDC69(?:\uD83C\uDFFF\u200D[\u2695\u2696\u2708]|\uD83C\uDFFE\u200D[\u2695\u2696\u2708]|\uD83C\uDFFC\u200D[\u2695\u2696\u2708]|\uD83C\uDFFB\u200D[\u2695\u2696\u2708]|\uD83C\uDFFD\u200D[\u2695\u2696\u2708]|\u200D[\u2695\u2696\u2708])|(?:(?:\u26F9|\uD83C[\uDFCB\uDFCC]|\uD83D\uDD75)\uFE0F|\uD83D\uDC6F|\uD83E[\uDD3C\uDDDE\uDDDF])\u200D[\u2640\u2642]|(?:\u26F9|\uD83C[\uDFCB\uDFCC]|\uD83D\uDD75)(?:\uD83C[\uDFFB-\uDFFF])\u200D[\u2640\u2642]|(?:\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD6-\uDDDD])(?:(?:\uD83C[\uDFFB-\uDFFF])\u200D[\u2640\u2642]|\u200D[\u2640\u2642])|\uD83C\uDFF4\u200D\u2620)\uFE0F|\uD83D\uDC69\u200D\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67])|\uD83C\uDFF3\uFE0F\u200D\uD83C\uDF08|\uD83D\uDC15\u200D\uD83E\uDDBA|\uD83D\uDC69\u200D\uD83D\uDC66|\uD83D\uDC69\u200D\uD83D\uDC67|\uD83C\uDDFD\uD83C\uDDF0|\uD83C\uDDF4\uD83C\uDDF2|\uD83C\uDDF6\uD83C\uDDE6|[#\*0-9]\uFE0F\u20E3|\uD83C\uDDE7(?:\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEF\uDDF1-\uDDF4\uDDF6-\uDDF9\uDDFB\uDDFC\uDDFE\uDDFF])|\uD83C\uDDF9(?:\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDED\uDDEF-\uDDF4\uDDF7\uDDF9\uDDFB\uDDFC\uDDFF])|\uD83C\uDDEA(?:\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDED\uDDF7-\uDDFA])|\uD83E\uDDD1(?:\uD83C[\uDFFB-\uDFFF])|\uD83C\uDDF7(?:\uD83C[\uDDEA\uDDF4\uDDF8\uDDFA\uDDFC])|\uD83D\uDC69(?:\uD83C[\uDFFB-\uDFFF])|\uD83C\uDDF2(?:\uD83C[\uDDE6\uDDE8-\uDDED\uDDF0-\uDDFF])|\uD83C\uDDE6(?:\uD83C[\uDDE8-\uDDEC\uDDEE\uDDF1\uDDF2\uDDF4\uDDF6-\uDDFA\uDDFC\uDDFD\uDDFF])|\uD83C\uDDF0(?:\uD83C[\uDDEA\uDDEC-\uDDEE\uDDF2\uDDF3\uDDF5\uDDF7\uDDFC\uDDFE\uDDFF])|\uD83C\uDDED(?:\uD83C[\uDDF0\uDDF2\uDDF3\uDDF7\uDDF9\uDDFA])|\uD83C\uDDE9(?:\uD83C[\uDDEA\uDDEC\uDDEF\uDDF0\uDDF2\uDDF4\uDDFF])|\uD83C\uDDFE(?:\uD83C[\uDDEA\uDDF9])|\uD83C\uDDEC(?:\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEE\uDDF1-\uDDF3\uDDF5-\uDDFA\uDDFC\uDDFE])|\uD83C\uDDF8(?:\uD83C[\uDDE6-\uDDEA\uDDEC-\uDDF4\uDDF7-\uDDF9\uDDFB\uDDFD-\uDDFF])|\uD83C\uDDEB(?:\uD83C[\uDDEE-\uDDF0\uDDF2\uDDF4\uDDF7])|\uD83C\uDDF5(?:\uD83C[\uDDE6\uDDEA-\uDDED\uDDF0-\uDDF3\uDDF7-\uDDF9\uDDFC\uDDFE])|\uD83C\uDDFB(?:\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDEE\uDDF3\uDDFA])|\uD83C\uDDF3(?:\uD83C[\uDDE6\uDDE8\uDDEA-\uDDEC\uDDEE\uDDF1\uDDF4\uDDF5\uDDF7\uDDFA\uDDFF])|\uD83C\uDDE8(?:\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDEE\uDDF0-\uDDF5\uDDF7\uDDFA-\uDDFF])|\uD83C\uDDF1(?:\uD83C[\uDDE6-\uDDE8\uDDEE\uDDF0\uDDF7-\uDDFB\uDDFE])|\uD83C\uDDFF(?:\uD83C[\uDDE6\uDDF2\uDDFC])|\uD83C\uDDFC(?:\uD83C[\uDDEB\uDDF8])|\uD83C\uDDFA(?:\uD83C[\uDDE6\uDDEC\uDDF2\uDDF3\uDDF8\uDDFE\uDDFF])|\uD83C\uDDEE(?:\uD83C[\uDDE8-\uDDEA\uDDF1-\uDDF4\uDDF6-\uDDF9])|\uD83C\uDDEF(?:\uD83C[\uDDEA\uDDF2\uDDF4\uDDF5])|(?:\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD6-\uDDDD])(?:\uD83C[\uDFFB-\uDFFF])|(?:\u26F9|\uD83C[\uDFCB\uDFCC]|\uD83D\uDD75)(?:\uD83C[\uDFFB-\uDFFF])|(?:[\u261D\u270A-\u270D]|\uD83C[\uDF85\uDFC2\uDFC7]|\uD83D[\uDC42\uDC43\uDC46-\uDC50\uDC66\uDC67\uDC6B-\uDC6D\uDC70\uDC72\uDC74-\uDC76\uDC78\uDC7C\uDC83\uDC85\uDCAA\uDD74\uDD7A\uDD90\uDD95\uDD96\uDE4C\uDE4F\uDEC0\uDECC]|\uD83E[\uDD0F\uDD18-\uDD1C\uDD1E\uDD1F\uDD30-\uDD36\uDDB5\uDDB6\uDDBB\uDDD2-\uDDD5])(?:\uD83C[\uDFFB-\uDFFF])|(?:[\u231A\u231B\u23E9-\u23EC\u23F0\u23F3\u25FD\u25FE\u2614\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA\u26AB\u26BD\u26BE\u26C4\u26C5\u26CE\u26D4\u26EA\u26F2\u26F3\u26F5\u26FA\u26FD\u2705\u270A\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B\u2B1C\u2B50\u2B55]|\uD83C[\uDC04\uDCCF\uDD8E\uDD91-\uDD9A\uDDE6-\uDDFF\uDE01\uDE1A\uDE2F\uDE32-\uDE36\uDE38-\uDE3A\uDE50\uDE51\uDF00-\uDF20\uDF2D-\uDF35\uDF37-\uDF7C\uDF7E-\uDF93\uDFA0-\uDFCA\uDFCF-\uDFD3\uDFE0-\uDFF0\uDFF4\uDFF8-\uDFFF]|\uD83D[\uDC00-\uDC3E\uDC40\uDC42-\uDCFC\uDCFF-\uDD3D\uDD4B-\uDD4E\uDD50-\uDD67\uDD7A\uDD95\uDD96\uDDA4\uDDFB-\uDE4F\uDE80-\uDEC5\uDECC\uDED0-\uDED2\uDED5\uDEEB\uDEEC\uDEF4-\uDEFA\uDFE0-\uDFEB]|\uD83E[\uDD0D-\uDD3A\uDD3C-\uDD45\uDD47-\uDD71\uDD73-\uDD76\uDD7A-\uDDA2\uDDA5-\uDDAA\uDDAE-\uDDCA\uDDCD-\uDDFF\uDE70-\uDE73\uDE78-\uDE7A\uDE80-\uDE82\uDE90-\uDE95])|(?:[#\*0-9\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u2604\u260E\u2611\u2614\u2615\u2618\u261D\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u267F\u2692-\u2697\u2699\u269B\u269C\u26A0\u26A1\u26AA\u26AB\u26B0\u26B1\u26BD\u26BE\u26C4\u26C5\u26C8\u26CE\u26CF\u26D1\u26D3\u26D4\u26E9\u26EA\u26F0-\u26F5\u26F7-\u26FA\u26FD\u2702\u2705\u2708-\u270D\u270F\u2712\u2714\u2716\u271D\u2721\u2728\u2733\u2734\u2744\u2747\u274C\u274E\u2753-\u2755\u2757\u2763\u2764\u2795-\u2797\u27A1\u27B0\u27BF\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299]|\uD83C[\uDC04\uDCCF\uDD70\uDD71\uDD7E\uDD7F\uDD8E\uDD91-\uDD9A\uDDE6-\uDDFF\uDE01\uDE02\uDE1A\uDE2F\uDE32-\uDE3A\uDE50\uDE51\uDF00-\uDF21\uDF24-\uDF93\uDF96\uDF97\uDF99-\uDF9B\uDF9E-\uDFF0\uDFF3-\uDFF5\uDFF7-\uDFFF]|\uD83D[\uDC00-\uDCFD\uDCFF-\uDD3D\uDD49-\uDD4E\uDD50-\uDD67\uDD6F\uDD70\uDD73-\uDD7A\uDD87\uDD8A-\uDD8D\uDD90\uDD95\uDD96\uDDA4\uDDA5\uDDA8\uDDB1\uDDB2\uDDBC\uDDC2-\uDDC4\uDDD1-\uDDD3\uDDDC-\uDDDE\uDDE1\uDDE3\uDDE8\uDDEF\uDDF3\uDDFA-\uDE4F\uDE80-\uDEC5\uDECB-\uDED2\uDED5\uDEE0-\uDEE5\uDEE9\uDEEB\uDEEC\uDEF0\uDEF3-\uDEFA\uDFE0-\uDFEB]|\uD83E[\uDD0D-\uDD3A\uDD3C-\uDD45\uDD47-\uDD71\uDD73-\uDD76\uDD7A-\uDDA2\uDDA5-\uDDAA\uDDAE-\uDDCA\uDDCD-\uDDFF\uDE70-\uDE73\uDE78-\uDE7A\uDE80-\uDE82\uDE90-\uDE95])\uFE0F|(?:[\u261D\u26F9\u270A-\u270D]|\uD83C[\uDF85\uDFC2-\uDFC4\uDFC7\uDFCA-\uDFCC]|\uD83D[\uDC42\uDC43\uDC46-\uDC50\uDC66-\uDC78\uDC7C\uDC81-\uDC83\uDC85-\uDC87\uDC8F\uDC91\uDCAA\uDD74\uDD75\uDD7A\uDD90\uDD95\uDD96\uDE45-\uDE47\uDE4B-\uDE4F\uDEA3\uDEB4-\uDEB6\uDEC0\uDECC]|\uD83E[\uDD0F\uDD18-\uDD1F\uDD26\uDD30-\uDD39\uDD3C-\uDD3E\uDDB5\uDDB6\uDDB8\uDDB9\uDDBB\uDDCD-\uDDCF\uDDD1-\uDDDD])/g;
  };
});

// ../node_modules/string-width/index.js
var require_string_width = __commonJS((exports, module) => {
  var stripAnsi = require_strip_ansi();
  var isFullwidthCodePoint = require_is_fullwidth_code_point();
  var emojiRegex = require_emoji_regex();
  var stringWidth = (string) => {
    if (typeof string !== "string" || string.length === 0) {
      return 0;
    }
    string = stripAnsi(string);
    if (string.length === 0) {
      return 0;
    }
    string = string.replace(emojiRegex(), "  ");
    let width = 0;
    for (let i = 0;i < string.length; i++) {
      const code = string.codePointAt(i);
      if (code <= 31 || code >= 127 && code <= 159) {
        continue;
      }
      if (code >= 768 && code <= 879) {
        continue;
      }
      if (code > 65535) {
        i++;
      }
      width += isFullwidthCodePoint(code) ? 2 : 1;
    }
    return width;
  };
  module.exports = stringWidth;
  module.exports.default = stringWidth;
});

// ../node_modules/cli-table3/src/utils.js
var require_utils = __commonJS((exports, module) => {
  var stringWidth = require_string_width();
  function codeRegex(capture) {
    return capture ? /\u001b\[((?:\d*;){0,5}\d*)m/g : /\u001b\[(?:\d*;){0,5}\d*m/g;
  }
  function strlen(str) {
    let code = codeRegex();
    let stripped = ("" + str).replace(code, "");
    let split = stripped.split(`
`);
    return split.reduce(function(memo, s) {
      return stringWidth(s) > memo ? stringWidth(s) : memo;
    }, 0);
  }
  function repeat(str, times) {
    return Array(times + 1).join(str);
  }
  function pad(str, len, pad2, dir) {
    let length = strlen(str);
    if (len + 1 >= length) {
      let padlen = len - length;
      switch (dir) {
        case "right": {
          str = repeat(pad2, padlen) + str;
          break;
        }
        case "center": {
          let right = Math.ceil(padlen / 2);
          let left = padlen - right;
          str = repeat(pad2, left) + str + repeat(pad2, right);
          break;
        }
        default: {
          str = str + repeat(pad2, padlen);
          break;
        }
      }
    }
    return str;
  }
  var codeCache = {};
  function addToCodeCache(name, on, off) {
    on = "\x1B[" + on + "m";
    off = "\x1B[" + off + "m";
    codeCache[on] = { set: name, to: true };
    codeCache[off] = { set: name, to: false };
    codeCache[name] = { on, off };
  }
  addToCodeCache("bold", 1, 22);
  addToCodeCache("italics", 3, 23);
  addToCodeCache("underline", 4, 24);
  addToCodeCache("inverse", 7, 27);
  addToCodeCache("strikethrough", 9, 29);
  function updateState(state, controlChars) {
    let controlCode = controlChars[1] ? parseInt(controlChars[1].split(";")[0]) : 0;
    if (controlCode >= 30 && controlCode <= 39 || controlCode >= 90 && controlCode <= 97) {
      state.lastForegroundAdded = controlChars[0];
      return;
    }
    if (controlCode >= 40 && controlCode <= 49 || controlCode >= 100 && controlCode <= 107) {
      state.lastBackgroundAdded = controlChars[0];
      return;
    }
    if (controlCode === 0) {
      for (let i in state) {
        if (Object.prototype.hasOwnProperty.call(state, i)) {
          delete state[i];
        }
      }
      return;
    }
    let info = codeCache[controlChars[0]];
    if (info) {
      state[info.set] = info.to;
    }
  }
  function readState(line) {
    let code = codeRegex(true);
    let controlChars = code.exec(line);
    let state = {};
    while (controlChars !== null) {
      updateState(state, controlChars);
      controlChars = code.exec(line);
    }
    return state;
  }
  function unwindState(state, ret) {
    let lastBackgroundAdded = state.lastBackgroundAdded;
    let lastForegroundAdded = state.lastForegroundAdded;
    delete state.lastBackgroundAdded;
    delete state.lastForegroundAdded;
    Object.keys(state).forEach(function(key) {
      if (state[key]) {
        ret += codeCache[key].off;
      }
    });
    if (lastBackgroundAdded && lastBackgroundAdded != "\x1B[49m") {
      ret += "\x1B[49m";
    }
    if (lastForegroundAdded && lastForegroundAdded != "\x1B[39m") {
      ret += "\x1B[39m";
    }
    return ret;
  }
  function rewindState(state, ret) {
    let lastBackgroundAdded = state.lastBackgroundAdded;
    let lastForegroundAdded = state.lastForegroundAdded;
    delete state.lastBackgroundAdded;
    delete state.lastForegroundAdded;
    Object.keys(state).forEach(function(key) {
      if (state[key]) {
        ret = codeCache[key].on + ret;
      }
    });
    if (lastBackgroundAdded && lastBackgroundAdded != "\x1B[49m") {
      ret = lastBackgroundAdded + ret;
    }
    if (lastForegroundAdded && lastForegroundAdded != "\x1B[39m") {
      ret = lastForegroundAdded + ret;
    }
    return ret;
  }
  function truncateWidth(str, desiredLength) {
    if (str.length === strlen(str)) {
      return str.substr(0, desiredLength);
    }
    while (strlen(str) > desiredLength) {
      str = str.slice(0, -1);
    }
    return str;
  }
  function truncateWidthWithAnsi(str, desiredLength) {
    let code = codeRegex(true);
    let split = str.split(codeRegex());
    let splitIndex = 0;
    let retLen = 0;
    let ret = "";
    let myArray;
    let state = {};
    while (retLen < desiredLength) {
      myArray = code.exec(str);
      let toAdd = split[splitIndex];
      splitIndex++;
      if (retLen + strlen(toAdd) > desiredLength) {
        toAdd = truncateWidth(toAdd, desiredLength - retLen);
      }
      ret += toAdd;
      retLen += strlen(toAdd);
      if (retLen < desiredLength) {
        if (!myArray) {
          break;
        }
        ret += myArray[0];
        updateState(state, myArray);
      }
    }
    return unwindState(state, ret);
  }
  function truncate(str, desiredLength, truncateChar) {
    truncateChar = truncateChar || "…";
    let lengthOfStr = strlen(str);
    if (lengthOfStr <= desiredLength) {
      return str;
    }
    desiredLength -= strlen(truncateChar);
    let ret = truncateWidthWithAnsi(str, desiredLength);
    ret += truncateChar;
    const hrefTag = "\x1B]8;;\x07";
    if (str.includes(hrefTag) && !ret.includes(hrefTag)) {
      ret += hrefTag;
    }
    return ret;
  }
  function defaultOptions() {
    return {
      chars: {
        top: "─",
        "top-mid": "┬",
        "top-left": "┌",
        "top-right": "┐",
        bottom: "─",
        "bottom-mid": "┴",
        "bottom-left": "└",
        "bottom-right": "┘",
        left: "│",
        "left-mid": "├",
        mid: "─",
        "mid-mid": "┼",
        right: "│",
        "right-mid": "┤",
        middle: "│"
      },
      truncate: "…",
      colWidths: [],
      rowHeights: [],
      colAligns: [],
      rowAligns: [],
      style: {
        "padding-left": 1,
        "padding-right": 1,
        head: ["red"],
        border: ["grey"],
        compact: false
      },
      head: []
    };
  }
  function mergeOptions(options, defaults) {
    options = options || {};
    defaults = defaults || defaultOptions();
    let ret = Object.assign({}, defaults, options);
    ret.chars = Object.assign({}, defaults.chars, options.chars);
    ret.style = Object.assign({}, defaults.style, options.style);
    return ret;
  }
  function wordWrap(maxLength, input) {
    let lines = [];
    let split = input.split(/(\s+)/g);
    let line = [];
    let lineLength = 0;
    let whitespace;
    for (let i = 0;i < split.length; i += 2) {
      let word = split[i];
      let newLength = lineLength + strlen(word);
      if (lineLength > 0 && whitespace) {
        newLength += whitespace.length;
      }
      if (newLength > maxLength) {
        if (lineLength !== 0) {
          lines.push(line.join(""));
        }
        line = [word];
        lineLength = strlen(word);
      } else {
        line.push(whitespace || "", word);
        lineLength = newLength;
      }
      whitespace = split[i + 1];
    }
    if (lineLength) {
      lines.push(line.join(""));
    }
    return lines;
  }
  function textWrap(maxLength, input) {
    let lines = [];
    let line = "";
    function pushLine(str, ws) {
      if (line.length && ws)
        line += ws;
      line += str;
      while (line.length > maxLength) {
        lines.push(line.slice(0, maxLength));
        line = line.slice(maxLength);
      }
    }
    let split = input.split(/(\s+)/g);
    for (let i = 0;i < split.length; i += 2) {
      pushLine(split[i], i && split[i - 1]);
    }
    if (line.length)
      lines.push(line);
    return lines;
  }
  function multiLineWordWrap(maxLength, input, wrapOnWordBoundary = true) {
    let output = [];
    input = input.split(`
`);
    const handler = wrapOnWordBoundary ? wordWrap : textWrap;
    for (let i = 0;i < input.length; i++) {
      output.push.apply(output, handler(maxLength, input[i]));
    }
    return output;
  }
  function colorizeLines(input) {
    let state = {};
    let output = [];
    for (let i = 0;i < input.length; i++) {
      let line = rewindState(state, input[i]);
      state = readState(line);
      let temp = Object.assign({}, state);
      output.push(unwindState(temp, line));
    }
    return output;
  }
  function hyperlink(url, text) {
    const OSC = "\x1B]";
    const BEL = "\x07";
    const SEP = ";";
    return [OSC, "8", SEP, SEP, url || text, BEL, text, OSC, "8", SEP, SEP, BEL].join("");
  }
  module.exports = {
    strlen,
    repeat,
    pad,
    truncate,
    mergeOptions,
    wordWrap: multiLineWordWrap,
    colorizeLines,
    hyperlink
  };
});

// ../node_modules/@colors/colors/lib/styles.js
var require_styles = __commonJS((exports, module) => {
  var styles = {};
  module["exports"] = styles;
  var codes = {
    reset: [0, 0],
    bold: [1, 22],
    dim: [2, 22],
    italic: [3, 23],
    underline: [4, 24],
    inverse: [7, 27],
    hidden: [8, 28],
    strikethrough: [9, 29],
    black: [30, 39],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    blue: [34, 39],
    magenta: [35, 39],
    cyan: [36, 39],
    white: [37, 39],
    gray: [90, 39],
    grey: [90, 39],
    brightRed: [91, 39],
    brightGreen: [92, 39],
    brightYellow: [93, 39],
    brightBlue: [94, 39],
    brightMagenta: [95, 39],
    brightCyan: [96, 39],
    brightWhite: [97, 39],
    bgBlack: [40, 49],
    bgRed: [41, 49],
    bgGreen: [42, 49],
    bgYellow: [43, 49],
    bgBlue: [44, 49],
    bgMagenta: [45, 49],
    bgCyan: [46, 49],
    bgWhite: [47, 49],
    bgGray: [100, 49],
    bgGrey: [100, 49],
    bgBrightRed: [101, 49],
    bgBrightGreen: [102, 49],
    bgBrightYellow: [103, 49],
    bgBrightBlue: [104, 49],
    bgBrightMagenta: [105, 49],
    bgBrightCyan: [106, 49],
    bgBrightWhite: [107, 49],
    blackBG: [40, 49],
    redBG: [41, 49],
    greenBG: [42, 49],
    yellowBG: [43, 49],
    blueBG: [44, 49],
    magentaBG: [45, 49],
    cyanBG: [46, 49],
    whiteBG: [47, 49]
  };
  Object.keys(codes).forEach(function(key) {
    var val = codes[key];
    var style = styles[key] = [];
    style.open = "\x1B[" + val[0] + "m";
    style.close = "\x1B[" + val[1] + "m";
  });
});

// ../node_modules/@colors/colors/lib/system/has-flag.js
var require_has_flag = __commonJS((exports, module) => {
  module.exports = function(flag, argv) {
    argv = argv || process.argv;
    var terminatorPos = argv.indexOf("--");
    var prefix = /^-{1,2}/.test(flag) ? "" : "--";
    var pos = argv.indexOf(prefix + flag);
    return pos !== -1 && (terminatorPos === -1 ? true : pos < terminatorPos);
  };
});

// ../node_modules/@colors/colors/lib/system/supports-colors.js
var require_supports_colors = __commonJS((exports, module) => {
  var os = __require("os");
  var hasFlag = require_has_flag();
  var env = process.env;
  var forceColor = undefined;
  if (hasFlag("no-color") || hasFlag("no-colors") || hasFlag("color=false")) {
    forceColor = false;
  } else if (hasFlag("color") || hasFlag("colors") || hasFlag("color=true") || hasFlag("color=always")) {
    forceColor = true;
  }
  if ("FORCE_COLOR" in env) {
    forceColor = env.FORCE_COLOR.length === 0 || parseInt(env.FORCE_COLOR, 10) !== 0;
  }
  function translateLevel(level) {
    if (level === 0) {
      return false;
    }
    return {
      level,
      hasBasic: true,
      has256: level >= 2,
      has16m: level >= 3
    };
  }
  function supportsColor(stream) {
    if (forceColor === false) {
      return 0;
    }
    if (hasFlag("color=16m") || hasFlag("color=full") || hasFlag("color=truecolor")) {
      return 3;
    }
    if (hasFlag("color=256")) {
      return 2;
    }
    if (stream && !stream.isTTY && forceColor !== true) {
      return 0;
    }
    var min = forceColor ? 1 : 0;
    if (process.platform === "win32") {
      var osRelease = os.release().split(".");
      if (Number(process.versions.node.split(".")[0]) >= 8 && Number(osRelease[0]) >= 10 && Number(osRelease[2]) >= 10586) {
        return Number(osRelease[2]) >= 14931 ? 3 : 2;
      }
      return 1;
    }
    if ("CI" in env) {
      if (["TRAVIS", "CIRCLECI", "APPVEYOR", "GITLAB_CI"].some(function(sign) {
        return sign in env;
      }) || env.CI_NAME === "codeship") {
        return 1;
      }
      return min;
    }
    if ("TEAMCITY_VERSION" in env) {
      return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION) ? 1 : 0;
    }
    if ("TERM_PROGRAM" in env) {
      var version = parseInt((env.TERM_PROGRAM_VERSION || "").split(".")[0], 10);
      switch (env.TERM_PROGRAM) {
        case "iTerm.app":
          return version >= 3 ? 3 : 2;
        case "Hyper":
          return 3;
        case "Apple_Terminal":
          return 2;
      }
    }
    if (/-256(color)?$/i.test(env.TERM)) {
      return 2;
    }
    if (/^screen|^xterm|^vt100|^rxvt|color|ansi|cygwin|linux/i.test(env.TERM)) {
      return 1;
    }
    if ("COLORTERM" in env) {
      return 1;
    }
    if (env.TERM === "dumb") {
      return min;
    }
    return min;
  }
  function getSupportLevel(stream) {
    var level = supportsColor(stream);
    return translateLevel(level);
  }
  module.exports = {
    supportsColor: getSupportLevel,
    stdout: getSupportLevel(process.stdout),
    stderr: getSupportLevel(process.stderr)
  };
});

// ../node_modules/@colors/colors/lib/custom/trap.js
var require_trap = __commonJS((exports, module) => {
  module["exports"] = function runTheTrap(text, options) {
    var result = "";
    text = text || "Run the trap, drop the bass";
    text = text.split("");
    var trap = {
      a: ["@", "Ą", "Ⱥ", "Ʌ", "Δ", "Λ", "Д"],
      b: ["ß", "Ɓ", "Ƀ", "ɮ", "β", "฿"],
      c: ["©", "Ȼ", "Ͼ"],
      d: ["Ð", "Ɗ", "Ԁ", "ԁ", "Ԃ", "ԃ"],
      e: [
        "Ë",
        "ĕ",
        "Ǝ",
        "ɘ",
        "Σ",
        "ξ",
        "Ҽ",
        "੬"
      ],
      f: ["Ӻ"],
      g: ["ɢ"],
      h: ["Ħ", "ƕ", "Ң", "Һ", "Ӈ", "Ԋ"],
      i: ["༏"],
      j: ["Ĵ"],
      k: ["ĸ", "Ҡ", "Ӄ", "Ԟ"],
      l: ["Ĺ"],
      m: ["ʍ", "Ӎ", "ӎ", "Ԡ", "ԡ", "൩"],
      n: ["Ñ", "ŋ", "Ɲ", "Ͷ", "Π", "Ҋ"],
      o: [
        "Ø",
        "õ",
        "ø",
        "Ǿ",
        "ʘ",
        "Ѻ",
        "ם",
        "۝",
        "๏"
      ],
      p: ["Ƿ", "Ҏ"],
      q: ["্"],
      r: ["®", "Ʀ", "Ȑ", "Ɍ", "ʀ", "Я"],
      s: ["§", "Ϟ", "ϟ", "Ϩ"],
      t: ["Ł", "Ŧ", "ͳ"],
      u: ["Ʊ", "Ս"],
      v: ["ט"],
      w: ["Ш", "Ѡ", "Ѽ", "൰"],
      x: ["Ҳ", "Ӿ", "Ӽ", "ӽ"],
      y: ["¥", "Ұ", "Ӌ"],
      z: ["Ƶ", "ɀ"]
    };
    text.forEach(function(c) {
      c = c.toLowerCase();
      var chars = trap[c] || [" "];
      var rand = Math.floor(Math.random() * chars.length);
      if (typeof trap[c] !== "undefined") {
        result += trap[c][rand];
      } else {
        result += c;
      }
    });
    return result;
  };
});

// ../node_modules/@colors/colors/lib/custom/zalgo.js
var require_zalgo = __commonJS((exports, module) => {
  module["exports"] = function zalgo(text, options) {
    text = text || "   he is here   ";
    var soul = {
      up: [
        "̍",
        "̎",
        "̄",
        "̅",
        "̿",
        "̑",
        "̆",
        "̐",
        "͒",
        "͗",
        "͑",
        "̇",
        "̈",
        "̊",
        "͂",
        "̓",
        "̈",
        "͊",
        "͋",
        "͌",
        "̃",
        "̂",
        "̌",
        "͐",
        "̀",
        "́",
        "̋",
        "̏",
        "̒",
        "̓",
        "̔",
        "̽",
        "̉",
        "ͣ",
        "ͤ",
        "ͥ",
        "ͦ",
        "ͧ",
        "ͨ",
        "ͩ",
        "ͪ",
        "ͫ",
        "ͬ",
        "ͭ",
        "ͮ",
        "ͯ",
        "̾",
        "͛",
        "͆",
        "̚"
      ],
      down: [
        "̖",
        "̗",
        "̘",
        "̙",
        "̜",
        "̝",
        "̞",
        "̟",
        "̠",
        "̤",
        "̥",
        "̦",
        "̩",
        "̪",
        "̫",
        "̬",
        "̭",
        "̮",
        "̯",
        "̰",
        "̱",
        "̲",
        "̳",
        "̹",
        "̺",
        "̻",
        "̼",
        "ͅ",
        "͇",
        "͈",
        "͉",
        "͍",
        "͎",
        "͓",
        "͔",
        "͕",
        "͖",
        "͙",
        "͚",
        "̣"
      ],
      mid: [
        "̕",
        "̛",
        "̀",
        "́",
        "͘",
        "̡",
        "̢",
        "̧",
        "̨",
        "̴",
        "̵",
        "̶",
        "͜",
        "͝",
        "͞",
        "͟",
        "͠",
        "͢",
        "̸",
        "̷",
        "͡",
        " ҉"
      ]
    };
    var all = [].concat(soul.up, soul.down, soul.mid);
    function randomNumber(range) {
      var r = Math.floor(Math.random() * range);
      return r;
    }
    function isChar(character) {
      var bool = false;
      all.filter(function(i) {
        bool = i === character;
      });
      return bool;
    }
    function heComes(text2, options2) {
      var result = "";
      var counts;
      var l;
      options2 = options2 || {};
      options2["up"] = typeof options2["up"] !== "undefined" ? options2["up"] : true;
      options2["mid"] = typeof options2["mid"] !== "undefined" ? options2["mid"] : true;
      options2["down"] = typeof options2["down"] !== "undefined" ? options2["down"] : true;
      options2["size"] = typeof options2["size"] !== "undefined" ? options2["size"] : "maxi";
      text2 = text2.split("");
      for (l in text2) {
        if (isChar(l)) {
          continue;
        }
        result = result + text2[l];
        counts = { up: 0, down: 0, mid: 0 };
        switch (options2.size) {
          case "mini":
            counts.up = randomNumber(8);
            counts.mid = randomNumber(2);
            counts.down = randomNumber(8);
            break;
          case "maxi":
            counts.up = randomNumber(16) + 3;
            counts.mid = randomNumber(4) + 1;
            counts.down = randomNumber(64) + 3;
            break;
          default:
            counts.up = randomNumber(8) + 1;
            counts.mid = randomNumber(6) / 2;
            counts.down = randomNumber(8) + 1;
            break;
        }
        var arr = ["up", "mid", "down"];
        for (var d in arr) {
          var index = arr[d];
          for (var i = 0;i <= counts[index]; i++) {
            if (options2[index]) {
              result = result + soul[index][randomNumber(soul[index].length)];
            }
          }
        }
      }
      return result;
    }
    return heComes(text, options);
  };
});

// ../node_modules/@colors/colors/lib/maps/america.js
var require_america = __commonJS((exports, module) => {
  module["exports"] = function(colors) {
    return function(letter, i, exploded) {
      if (letter === " ")
        return letter;
      switch (i % 3) {
        case 0:
          return colors.red(letter);
        case 1:
          return colors.white(letter);
        case 2:
          return colors.blue(letter);
      }
    };
  };
});

// ../node_modules/@colors/colors/lib/maps/zebra.js
var require_zebra = __commonJS((exports, module) => {
  module["exports"] = function(colors) {
    return function(letter, i, exploded) {
      return i % 2 === 0 ? letter : colors.inverse(letter);
    };
  };
});

// ../node_modules/@colors/colors/lib/maps/rainbow.js
var require_rainbow = __commonJS((exports, module) => {
  module["exports"] = function(colors) {
    var rainbowColors = ["red", "yellow", "green", "blue", "magenta"];
    return function(letter, i, exploded) {
      if (letter === " ") {
        return letter;
      } else {
        return colors[rainbowColors[i++ % rainbowColors.length]](letter);
      }
    };
  };
});

// ../node_modules/@colors/colors/lib/maps/random.js
var require_random = __commonJS((exports, module) => {
  module["exports"] = function(colors) {
    var available = [
      "underline",
      "inverse",
      "grey",
      "yellow",
      "red",
      "green",
      "blue",
      "white",
      "cyan",
      "magenta",
      "brightYellow",
      "brightRed",
      "brightGreen",
      "brightBlue",
      "brightWhite",
      "brightCyan",
      "brightMagenta"
    ];
    return function(letter, i, exploded) {
      return letter === " " ? letter : colors[available[Math.round(Math.random() * (available.length - 2))]](letter);
    };
  };
});

// ../node_modules/@colors/colors/lib/colors.js
var require_colors = __commonJS((exports, module) => {
  var colors = {};
  module["exports"] = colors;
  colors.themes = {};
  var util = __require("util");
  var ansiStyles = colors.styles = require_styles();
  var defineProps = Object.defineProperties;
  var newLineRegex = new RegExp(/[\r\n]+/g);
  colors.supportsColor = require_supports_colors().supportsColor;
  if (typeof colors.enabled === "undefined") {
    colors.enabled = colors.supportsColor() !== false;
  }
  colors.enable = function() {
    colors.enabled = true;
  };
  colors.disable = function() {
    colors.enabled = false;
  };
  colors.stripColors = colors.strip = function(str) {
    return ("" + str).replace(/\x1B\[\d+m/g, "");
  };
  var stylize = colors.stylize = function stylize2(str, style) {
    if (!colors.enabled) {
      return str + "";
    }
    var styleMap = ansiStyles[style];
    if (!styleMap && style in colors) {
      return colors[style](str);
    }
    return styleMap.open + str + styleMap.close;
  };
  var matchOperatorsRe = /[|\\{}()[\]^$+*?.]/g;
  var escapeStringRegexp = function(str) {
    if (typeof str !== "string") {
      throw new TypeError("Expected a string");
    }
    return str.replace(matchOperatorsRe, "\\$&");
  };
  function build(_styles) {
    var builder = function builder2() {
      return applyStyle.apply(builder2, arguments);
    };
    builder._styles = _styles;
    builder.__proto__ = proto;
    return builder;
  }
  var styles = function() {
    var ret = {};
    ansiStyles.grey = ansiStyles.gray;
    Object.keys(ansiStyles).forEach(function(key) {
      ansiStyles[key].closeRe = new RegExp(escapeStringRegexp(ansiStyles[key].close), "g");
      ret[key] = {
        get: function() {
          return build(this._styles.concat(key));
        }
      };
    });
    return ret;
  }();
  var proto = defineProps(function colors2() {}, styles);
  function applyStyle() {
    var args = Array.prototype.slice.call(arguments);
    var str = args.map(function(arg) {
      if (arg != null && arg.constructor === String) {
        return arg;
      } else {
        return util.inspect(arg);
      }
    }).join(" ");
    if (!colors.enabled || !str) {
      return str;
    }
    var newLinesPresent = str.indexOf(`
`) != -1;
    var nestedStyles = this._styles;
    var i = nestedStyles.length;
    while (i--) {
      var code = ansiStyles[nestedStyles[i]];
      str = code.open + str.replace(code.closeRe, code.open) + code.close;
      if (newLinesPresent) {
        str = str.replace(newLineRegex, function(match) {
          return code.close + match + code.open;
        });
      }
    }
    return str;
  }
  colors.setTheme = function(theme) {
    if (typeof theme === "string") {
      console.log("colors.setTheme now only accepts an object, not a string.  " + "If you are trying to set a theme from a file, it is now your (the " + "caller's) responsibility to require the file.  The old syntax " + "looked like colors.setTheme(__dirname + " + "'/../themes/generic-logging.js'); The new syntax looks like " + "colors.setTheme(require(__dirname + " + "'/../themes/generic-logging.js'));");
      return;
    }
    for (var style in theme) {
      (function(style2) {
        colors[style2] = function(str) {
          if (typeof theme[style2] === "object") {
            var out = str;
            for (var i in theme[style2]) {
              out = colors[theme[style2][i]](out);
            }
            return out;
          }
          return colors[theme[style2]](str);
        };
      })(style);
    }
  };
  function init() {
    var ret = {};
    Object.keys(styles).forEach(function(name) {
      ret[name] = {
        get: function() {
          return build([name]);
        }
      };
    });
    return ret;
  }
  var sequencer = function sequencer2(map3, str) {
    var exploded = str.split("");
    exploded = exploded.map(map3);
    return exploded.join("");
  };
  colors.trap = require_trap();
  colors.zalgo = require_zalgo();
  colors.maps = {};
  colors.maps.america = require_america()(colors);
  colors.maps.zebra = require_zebra()(colors);
  colors.maps.rainbow = require_rainbow()(colors);
  colors.maps.random = require_random()(colors);
  for (map2 in colors.maps) {
    (function(map3) {
      colors[map3] = function(str) {
        return sequencer(colors.maps[map3], str);
      };
    })(map2);
  }
  var map2;
  defineProps(colors, init());
});

// ../node_modules/@colors/colors/safe.js
var require_safe = __commonJS((exports, module) => {
  var colors = require_colors();
  module["exports"] = colors;
});

// ../node_modules/cli-table3/src/cell.js
var require_cell = __commonJS((exports, module) => {
  var { info, debug } = require_debug();
  var utils = require_utils();

  class Cell {
    constructor(options) {
      this.setOptions(options);
      this.x = null;
      this.y = null;
    }
    setOptions(options) {
      if (["boolean", "number", "bigint", "string"].indexOf(typeof options) !== -1) {
        options = { content: "" + options };
      }
      options = options || {};
      this.options = options;
      let content = options.content;
      if (["boolean", "number", "bigint", "string"].indexOf(typeof content) !== -1) {
        this.content = String(content);
      } else if (!content) {
        this.content = this.options.href || "";
      } else {
        throw new Error("Content needs to be a primitive, got: " + typeof content);
      }
      this.colSpan = options.colSpan || 1;
      this.rowSpan = options.rowSpan || 1;
      if (this.options.href) {
        Object.defineProperty(this, "href", {
          get() {
            return this.options.href;
          }
        });
      }
    }
    mergeTableOptions(tableOptions, cells) {
      this.cells = cells;
      let optionsChars = this.options.chars || {};
      let tableChars = tableOptions.chars;
      let chars = this.chars = {};
      CHAR_NAMES.forEach(function(name) {
        setOption(optionsChars, tableChars, name, chars);
      });
      this.truncate = this.options.truncate || tableOptions.truncate;
      let style = this.options.style = this.options.style || {};
      let tableStyle = tableOptions.style;
      setOption(style, tableStyle, "padding-left", this);
      setOption(style, tableStyle, "padding-right", this);
      this.head = style.head || tableStyle.head;
      this.border = style.border || tableStyle.border;
      this.fixedWidth = tableOptions.colWidths[this.x];
      this.lines = this.computeLines(tableOptions);
      this.desiredWidth = utils.strlen(this.content) + this.paddingLeft + this.paddingRight;
      this.desiredHeight = this.lines.length;
    }
    computeLines(tableOptions) {
      const tableWordWrap = tableOptions.wordWrap || tableOptions.textWrap;
      const { wordWrap = tableWordWrap } = this.options;
      if (this.fixedWidth && wordWrap) {
        this.fixedWidth -= this.paddingLeft + this.paddingRight;
        if (this.colSpan) {
          let i = 1;
          while (i < this.colSpan) {
            this.fixedWidth += tableOptions.colWidths[this.x + i];
            i++;
          }
        }
        const { wrapOnWordBoundary: tableWrapOnWordBoundary = true } = tableOptions;
        const { wrapOnWordBoundary = tableWrapOnWordBoundary } = this.options;
        return this.wrapLines(utils.wordWrap(this.fixedWidth, this.content, wrapOnWordBoundary));
      }
      return this.wrapLines(this.content.split(`
`));
    }
    wrapLines(computedLines) {
      const lines = utils.colorizeLines(computedLines);
      if (this.href) {
        return lines.map((line) => utils.hyperlink(this.href, line));
      }
      return lines;
    }
    init(tableOptions) {
      let x = this.x;
      let y = this.y;
      this.widths = tableOptions.colWidths.slice(x, x + this.colSpan);
      this.heights = tableOptions.rowHeights.slice(y, y + this.rowSpan);
      this.width = this.widths.reduce(sumPlusOne, -1);
      this.height = this.heights.reduce(sumPlusOne, -1);
      this.hAlign = this.options.hAlign || tableOptions.colAligns[x];
      this.vAlign = this.options.vAlign || tableOptions.rowAligns[y];
      this.drawRight = x + this.colSpan == tableOptions.colWidths.length;
    }
    draw(lineNum, spanningCell) {
      if (lineNum == "top")
        return this.drawTop(this.drawRight);
      if (lineNum == "bottom")
        return this.drawBottom(this.drawRight);
      let content = utils.truncate(this.content, 10, this.truncate);
      if (!lineNum) {
        info(`${this.y}-${this.x}: ${this.rowSpan - lineNum}x${this.colSpan} Cell ${content}`);
      } else {}
      let padLen = Math.max(this.height - this.lines.length, 0);
      let padTop;
      switch (this.vAlign) {
        case "center":
          padTop = Math.ceil(padLen / 2);
          break;
        case "bottom":
          padTop = padLen;
          break;
        default:
          padTop = 0;
      }
      if (lineNum < padTop || lineNum >= padTop + this.lines.length) {
        return this.drawEmpty(this.drawRight, spanningCell);
      }
      let forceTruncation = this.lines.length > this.height && lineNum + 1 >= this.height;
      return this.drawLine(lineNum - padTop, this.drawRight, forceTruncation, spanningCell);
    }
    drawTop(drawRight) {
      let content = [];
      if (this.cells) {
        this.widths.forEach(function(width, index) {
          content.push(this._topLeftChar(index));
          content.push(utils.repeat(this.chars[this.y == 0 ? "top" : "mid"], width));
        }, this);
      } else {
        content.push(this._topLeftChar(0));
        content.push(utils.repeat(this.chars[this.y == 0 ? "top" : "mid"], this.width));
      }
      if (drawRight) {
        content.push(this.chars[this.y == 0 ? "topRight" : "rightMid"]);
      }
      return this.wrapWithStyleColors("border", content.join(""));
    }
    _topLeftChar(offset) {
      let x = this.x + offset;
      let leftChar;
      if (this.y == 0) {
        leftChar = x == 0 ? "topLeft" : offset == 0 ? "topMid" : "top";
      } else {
        if (x == 0) {
          leftChar = "leftMid";
        } else {
          leftChar = offset == 0 ? "midMid" : "bottomMid";
          if (this.cells) {
            let spanAbove = this.cells[this.y - 1][x] instanceof Cell.ColSpanCell;
            if (spanAbove) {
              leftChar = offset == 0 ? "topMid" : "mid";
            }
            if (offset == 0) {
              let i = 1;
              while (this.cells[this.y][x - i] instanceof Cell.ColSpanCell) {
                i++;
              }
              if (this.cells[this.y][x - i] instanceof Cell.RowSpanCell) {
                leftChar = "leftMid";
              }
            }
          }
        }
      }
      return this.chars[leftChar];
    }
    wrapWithStyleColors(styleProperty, content) {
      if (this[styleProperty] && this[styleProperty].length) {
        try {
          let colors = require_safe();
          for (let i = this[styleProperty].length - 1;i >= 0; i--) {
            colors = colors[this[styleProperty][i]];
          }
          return colors(content);
        } catch (e) {
          return content;
        }
      } else {
        return content;
      }
    }
    drawLine(lineNum, drawRight, forceTruncationSymbol, spanningCell) {
      let left = this.chars[this.x == 0 ? "left" : "middle"];
      if (this.x && spanningCell && this.cells) {
        let cellLeft = this.cells[this.y + spanningCell][this.x - 1];
        while (cellLeft instanceof ColSpanCell) {
          cellLeft = this.cells[cellLeft.y][cellLeft.x - 1];
        }
        if (!(cellLeft instanceof RowSpanCell)) {
          left = this.chars["rightMid"];
        }
      }
      let leftPadding = utils.repeat(" ", this.paddingLeft);
      let right = drawRight ? this.chars["right"] : "";
      let rightPadding = utils.repeat(" ", this.paddingRight);
      let line = this.lines[lineNum];
      let len = this.width - (this.paddingLeft + this.paddingRight);
      if (forceTruncationSymbol)
        line += this.truncate || "…";
      let content = utils.truncate(line, len, this.truncate);
      content = utils.pad(content, len, " ", this.hAlign);
      content = leftPadding + content + rightPadding;
      return this.stylizeLine(left, content, right);
    }
    stylizeLine(left, content, right) {
      left = this.wrapWithStyleColors("border", left);
      right = this.wrapWithStyleColors("border", right);
      if (this.y === 0) {
        content = this.wrapWithStyleColors("head", content);
      }
      return left + content + right;
    }
    drawBottom(drawRight) {
      let left = this.chars[this.x == 0 ? "bottomLeft" : "bottomMid"];
      let content = utils.repeat(this.chars.bottom, this.width);
      let right = drawRight ? this.chars["bottomRight"] : "";
      return this.wrapWithStyleColors("border", left + content + right);
    }
    drawEmpty(drawRight, spanningCell) {
      let left = this.chars[this.x == 0 ? "left" : "middle"];
      if (this.x && spanningCell && this.cells) {
        let cellLeft = this.cells[this.y + spanningCell][this.x - 1];
        while (cellLeft instanceof ColSpanCell) {
          cellLeft = this.cells[cellLeft.y][cellLeft.x - 1];
        }
        if (!(cellLeft instanceof RowSpanCell)) {
          left = this.chars["rightMid"];
        }
      }
      let right = drawRight ? this.chars["right"] : "";
      let content = utils.repeat(" ", this.width);
      return this.stylizeLine(left, content, right);
    }
  }

  class ColSpanCell {
    constructor() {}
    draw(lineNum) {
      if (typeof lineNum === "number") {
        debug(`${this.y}-${this.x}: 1x1 ColSpanCell`);
      }
      return "";
    }
    init() {}
    mergeTableOptions() {}
  }

  class RowSpanCell {
    constructor(originalCell) {
      this.originalCell = originalCell;
    }
    init(tableOptions) {
      let y = this.y;
      let originalY = this.originalCell.y;
      this.cellOffset = y - originalY;
      this.offset = findDimension(tableOptions.rowHeights, originalY, this.cellOffset);
    }
    draw(lineNum) {
      if (lineNum == "top") {
        return this.originalCell.draw(this.offset, this.cellOffset);
      }
      if (lineNum == "bottom") {
        return this.originalCell.draw("bottom");
      }
      debug(`${this.y}-${this.x}: 1x${this.colSpan} RowSpanCell for ${this.originalCell.content}`);
      return this.originalCell.draw(this.offset + 1 + lineNum);
    }
    mergeTableOptions() {}
  }
  function firstDefined(...args) {
    return args.filter((v) => v !== undefined && v !== null).shift();
  }
  function setOption(objA, objB, nameB, targetObj) {
    let nameA = nameB.split("-");
    if (nameA.length > 1) {
      nameA[1] = nameA[1].charAt(0).toUpperCase() + nameA[1].substr(1);
      nameA = nameA.join("");
      targetObj[nameA] = firstDefined(objA[nameA], objA[nameB], objB[nameA], objB[nameB]);
    } else {
      targetObj[nameB] = firstDefined(objA[nameB], objB[nameB]);
    }
  }
  function findDimension(dimensionTable, startingIndex, span) {
    let ret = dimensionTable[startingIndex];
    for (let i = 1;i < span; i++) {
      ret += 1 + dimensionTable[startingIndex + i];
    }
    return ret;
  }
  function sumPlusOne(a, b) {
    return a + b + 1;
  }
  var CHAR_NAMES = [
    "top",
    "top-mid",
    "top-left",
    "top-right",
    "bottom",
    "bottom-mid",
    "bottom-left",
    "bottom-right",
    "left",
    "left-mid",
    "mid",
    "mid-mid",
    "right",
    "right-mid",
    "middle"
  ];
  module.exports = Cell;
  module.exports.ColSpanCell = ColSpanCell;
  module.exports.RowSpanCell = RowSpanCell;
});

// ../node_modules/cli-table3/src/layout-manager.js
var require_layout_manager = __commonJS((exports, module) => {
  var { warn, debug } = require_debug();
  var Cell = require_cell();
  var { ColSpanCell, RowSpanCell } = Cell;
  (function() {
    function next(alloc, col) {
      if (alloc[col] > 0) {
        return next(alloc, col + 1);
      }
      return col;
    }
    function layoutTable(table) {
      let alloc = {};
      table.forEach(function(row, rowIndex) {
        let col = 0;
        row.forEach(function(cell) {
          cell.y = rowIndex;
          cell.x = rowIndex ? next(alloc, col) : col;
          const rowSpan = cell.rowSpan || 1;
          const colSpan = cell.colSpan || 1;
          if (rowSpan > 1) {
            for (let cs = 0;cs < colSpan; cs++) {
              alloc[cell.x + cs] = rowSpan;
            }
          }
          col = cell.x + colSpan;
        });
        Object.keys(alloc).forEach((idx) => {
          alloc[idx]--;
          if (alloc[idx] < 1)
            delete alloc[idx];
        });
      });
    }
    function maxWidth(table) {
      let mw = 0;
      table.forEach(function(row) {
        row.forEach(function(cell) {
          mw = Math.max(mw, cell.x + (cell.colSpan || 1));
        });
      });
      return mw;
    }
    function maxHeight(table) {
      return table.length;
    }
    function cellsConflict(cell1, cell2) {
      let yMin1 = cell1.y;
      let yMax1 = cell1.y - 1 + (cell1.rowSpan || 1);
      let yMin2 = cell2.y;
      let yMax2 = cell2.y - 1 + (cell2.rowSpan || 1);
      let yConflict = !(yMin1 > yMax2 || yMin2 > yMax1);
      let xMin1 = cell1.x;
      let xMax1 = cell1.x - 1 + (cell1.colSpan || 1);
      let xMin2 = cell2.x;
      let xMax2 = cell2.x - 1 + (cell2.colSpan || 1);
      let xConflict = !(xMin1 > xMax2 || xMin2 > xMax1);
      return yConflict && xConflict;
    }
    function conflictExists(rows, x, y) {
      let i_max = Math.min(rows.length - 1, y);
      let cell = { x, y };
      for (let i = 0;i <= i_max; i++) {
        let row = rows[i];
        for (let j = 0;j < row.length; j++) {
          if (cellsConflict(cell, row[j])) {
            return true;
          }
        }
      }
      return false;
    }
    function allBlank(rows, y, xMin, xMax) {
      for (let x = xMin;x < xMax; x++) {
        if (conflictExists(rows, x, y)) {
          return false;
        }
      }
      return true;
    }
    function addRowSpanCells(table) {
      table.forEach(function(row, rowIndex) {
        row.forEach(function(cell) {
          for (let i = 1;i < cell.rowSpan; i++) {
            let rowSpanCell = new RowSpanCell(cell);
            rowSpanCell.x = cell.x;
            rowSpanCell.y = cell.y + i;
            rowSpanCell.colSpan = cell.colSpan;
            insertCell(rowSpanCell, table[rowIndex + i]);
          }
        });
      });
    }
    function addColSpanCells(cellRows) {
      for (let rowIndex = cellRows.length - 1;rowIndex >= 0; rowIndex--) {
        let cellColumns = cellRows[rowIndex];
        for (let columnIndex = 0;columnIndex < cellColumns.length; columnIndex++) {
          let cell = cellColumns[columnIndex];
          for (let k = 1;k < cell.colSpan; k++) {
            let colSpanCell = new ColSpanCell;
            colSpanCell.x = cell.x + k;
            colSpanCell.y = cell.y;
            cellColumns.splice(columnIndex + 1, 0, colSpanCell);
          }
        }
      }
    }
    function insertCell(cell, row) {
      let x = 0;
      while (x < row.length && row[x].x < cell.x) {
        x++;
      }
      row.splice(x, 0, cell);
    }
    function fillInTable(table) {
      let h_max = maxHeight(table);
      let w_max = maxWidth(table);
      debug(`Max rows: ${h_max}; Max cols: ${w_max}`);
      for (let y = 0;y < h_max; y++) {
        for (let x = 0;x < w_max; x++) {
          if (!conflictExists(table, x, y)) {
            let opts = { x, y, colSpan: 1, rowSpan: 1 };
            x++;
            while (x < w_max && !conflictExists(table, x, y)) {
              opts.colSpan++;
              x++;
            }
            let y2 = y + 1;
            while (y2 < h_max && allBlank(table, y2, opts.x, opts.x + opts.colSpan)) {
              opts.rowSpan++;
              y2++;
            }
            let cell = new Cell(opts);
            cell.x = opts.x;
            cell.y = opts.y;
            warn(`Missing cell at ${cell.y}-${cell.x}.`);
            insertCell(cell, table[y]);
          }
        }
      }
    }
    function generateCells(rows) {
      return rows.map(function(row) {
        if (!Array.isArray(row)) {
          let key = Object.keys(row)[0];
          row = row[key];
          if (Array.isArray(row)) {
            row = row.slice();
            row.unshift(key);
          } else {
            row = [key, row];
          }
        }
        return row.map(function(cell) {
          return new Cell(cell);
        });
      });
    }
    function makeTableLayout(rows) {
      let cellRows = generateCells(rows);
      layoutTable(cellRows);
      fillInTable(cellRows);
      addRowSpanCells(cellRows);
      addColSpanCells(cellRows);
      return cellRows;
    }
    module.exports = {
      makeTableLayout,
      layoutTable,
      addRowSpanCells,
      maxWidth,
      fillInTable,
      computeWidths: makeComputeWidths("colSpan", "desiredWidth", "x", 1),
      computeHeights: makeComputeWidths("rowSpan", "desiredHeight", "y", 1)
    };
  })();
  function makeComputeWidths(colSpan, desiredWidth, x, forcedMin) {
    return function(vals, table) {
      let result = [];
      let spanners = [];
      let auto = {};
      table.forEach(function(row) {
        row.forEach(function(cell) {
          if ((cell[colSpan] || 1) > 1) {
            spanners.push(cell);
          } else {
            result[cell[x]] = Math.max(result[cell[x]] || 0, cell[desiredWidth] || 0, forcedMin);
          }
        });
      });
      vals.forEach(function(val, index) {
        if (typeof val === "number") {
          result[index] = val;
        }
      });
      for (let k = spanners.length - 1;k >= 0; k--) {
        let cell = spanners[k];
        let span = cell[colSpan];
        let col = cell[x];
        let existingWidth = result[col];
        let editableCols = typeof vals[col] === "number" ? 0 : 1;
        if (typeof existingWidth === "number") {
          for (let i = 1;i < span; i++) {
            existingWidth += 1 + result[col + i];
            if (typeof vals[col + i] !== "number") {
              editableCols++;
            }
          }
        } else {
          existingWidth = desiredWidth === "desiredWidth" ? cell.desiredWidth - 1 : 1;
          if (!auto[col] || auto[col] < existingWidth) {
            auto[col] = existingWidth;
          }
        }
        if (cell[desiredWidth] > existingWidth) {
          let i = 0;
          while (editableCols > 0 && cell[desiredWidth] > existingWidth) {
            if (typeof vals[col + i] !== "number") {
              let dif = Math.round((cell[desiredWidth] - existingWidth) / editableCols);
              existingWidth += dif;
              result[col + i] += dif;
              editableCols--;
            }
            i++;
          }
        }
      }
      Object.assign(vals, result, auto);
      for (let j = 0;j < vals.length; j++) {
        vals[j] = Math.max(forcedMin, vals[j] || 0);
      }
    };
  }
});

// ../node_modules/cli-table3/src/table.js
var require_table = __commonJS((exports, module) => {
  var debug = require_debug();
  var utils = require_utils();
  var tableLayout = require_layout_manager();

  class Table extends Array {
    constructor(opts) {
      super();
      const options = utils.mergeOptions(opts);
      Object.defineProperty(this, "options", {
        value: options,
        enumerable: options.debug
      });
      if (options.debug) {
        switch (typeof options.debug) {
          case "boolean":
            debug.setDebugLevel(debug.WARN);
            break;
          case "number":
            debug.setDebugLevel(options.debug);
            break;
          case "string":
            debug.setDebugLevel(parseInt(options.debug, 10));
            break;
          default:
            debug.setDebugLevel(debug.WARN);
            debug.warn(`Debug option is expected to be boolean, number, or string. Received a ${typeof options.debug}`);
        }
        Object.defineProperty(this, "messages", {
          get() {
            return debug.debugMessages();
          }
        });
      }
    }
    toString() {
      let array = this;
      let headersPresent = this.options.head && this.options.head.length;
      if (headersPresent) {
        array = [this.options.head];
        if (this.length) {
          array.push.apply(array, this);
        }
      } else {
        this.options.style.head = [];
      }
      let cells = tableLayout.makeTableLayout(array);
      cells.forEach(function(row) {
        row.forEach(function(cell) {
          cell.mergeTableOptions(this.options, cells);
        }, this);
      }, this);
      tableLayout.computeWidths(this.options.colWidths, cells);
      tableLayout.computeHeights(this.options.rowHeights, cells);
      cells.forEach(function(row) {
        row.forEach(function(cell) {
          cell.init(this.options);
        }, this);
      }, this);
      let result = [];
      for (let rowIndex = 0;rowIndex < cells.length; rowIndex++) {
        let row = cells[rowIndex];
        let heightOfRow = this.options.rowHeights[rowIndex];
        if (rowIndex === 0 || !this.options.style.compact || rowIndex == 1 && headersPresent) {
          doDraw(row, "top", result);
        }
        for (let lineNum = 0;lineNum < heightOfRow; lineNum++) {
          doDraw(row, lineNum, result);
        }
        if (rowIndex + 1 == cells.length) {
          doDraw(row, "bottom", result);
        }
      }
      return result.join(`
`);
    }
    get width() {
      let str = this.toString().split(`
`);
      return str[0].length;
    }
  }
  Table.reset = () => debug.reset();
  function doDraw(row, lineNum, result) {
    let line = [];
    row.forEach(function(cell) {
      line.push(cell.draw(lineNum));
    });
    let str = line.join("");
    if (str.length)
      result.push(str);
  }
  module.exports = Table;
});

// ../node_modules/commander/esm.mjs
var import__ = __toESM(require_commander(), 1);
var {
  program,
  createCommand,
  createArgument,
  createOption,
  CommanderError,
  InvalidArgumentError,
  InvalidOptionArgumentError,
  Command,
  Argument,
  Option,
  Help
} = import__.default;

// src/utils.ts
var import_papaparse = __toESM(require_papaparse(), 1);
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// ../node_modules/@trpc/client/dist/objectSpread2-BvkFp-_Y.mjs
var __create2 = Object.create;
var __defProp2 = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames2 = Object.getOwnPropertyNames;
var __getProtoOf2 = Object.getPrototypeOf;
var __hasOwnProp2 = Object.prototype.hasOwnProperty;
var __commonJS2 = (cb, mod) => function() {
  return mod || (0, cb[__getOwnPropNames2(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function")
    for (var keys = __getOwnPropNames2(from), i = 0, n = keys.length, key;i < n; i++) {
      key = keys[i];
      if (!__hasOwnProp2.call(to, key) && key !== except)
        __defProp2(to, key, {
          get: ((k) => from[k]).bind(null, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
    }
  return to;
};
var __toESM2 = (mod, isNodeMode, target) => (target = mod != null ? __create2(__getProtoOf2(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp2(target, "default", {
  value: mod,
  enumerable: true
}) : target, mod));
var require_typeof = __commonJS2({ "../../node_modules/.pnpm/@oxc-project+runtime@0.72.2/node_modules/@oxc-project/runtime/src/helpers/typeof.js"(exports, module) {
  function _typeof$2(o) {
    "@babel/helpers - typeof";
    return module.exports = _typeof$2 = typeof Symbol == "function" && typeof Symbol.iterator == "symbol" ? function(o$1) {
      return typeof o$1;
    } : function(o$1) {
      return o$1 && typeof Symbol == "function" && o$1.constructor === Symbol && o$1 !== Symbol.prototype ? "symbol" : typeof o$1;
    }, module.exports.__esModule = true, module.exports["default"] = module.exports, _typeof$2(o);
  }
  module.exports = _typeof$2, module.exports.__esModule = true, module.exports["default"] = module.exports;
} });
var require_toPrimitive = __commonJS2({ "../../node_modules/.pnpm/@oxc-project+runtime@0.72.2/node_modules/@oxc-project/runtime/src/helpers/toPrimitive.js"(exports, module) {
  var _typeof$1 = require_typeof()["default"];
  function toPrimitive$1(t, r) {
    if (_typeof$1(t) != "object" || !t)
      return t;
    var e = t[Symbol.toPrimitive];
    if (e !== undefined) {
      var i = e.call(t, r || "default");
      if (_typeof$1(i) != "object")
        return i;
      throw new TypeError("@@toPrimitive must return a primitive value.");
    }
    return (r === "string" ? String : Number)(t);
  }
  module.exports = toPrimitive$1, module.exports.__esModule = true, module.exports["default"] = module.exports;
} });
var require_toPropertyKey = __commonJS2({ "../../node_modules/.pnpm/@oxc-project+runtime@0.72.2/node_modules/@oxc-project/runtime/src/helpers/toPropertyKey.js"(exports, module) {
  var _typeof = require_typeof()["default"];
  var toPrimitive = require_toPrimitive();
  function toPropertyKey$1(t) {
    var i = toPrimitive(t, "string");
    return _typeof(i) == "symbol" ? i : i + "";
  }
  module.exports = toPropertyKey$1, module.exports.__esModule = true, module.exports["default"] = module.exports;
} });
var require_defineProperty = __commonJS2({ "../../node_modules/.pnpm/@oxc-project+runtime@0.72.2/node_modules/@oxc-project/runtime/src/helpers/defineProperty.js"(exports, module) {
  var toPropertyKey = require_toPropertyKey();
  function _defineProperty(e, r, t) {
    return (r = toPropertyKey(r)) in e ? Object.defineProperty(e, r, {
      value: t,
      enumerable: true,
      configurable: true,
      writable: true
    }) : e[r] = t, e;
  }
  module.exports = _defineProperty, module.exports.__esModule = true, module.exports["default"] = module.exports;
} });
var require_objectSpread2 = __commonJS2({ "../../node_modules/.pnpm/@oxc-project+runtime@0.72.2/node_modules/@oxc-project/runtime/src/helpers/objectSpread2.js"(exports, module) {
  var defineProperty = require_defineProperty();
  function ownKeys(e, r) {
    var t = Object.keys(e);
    if (Object.getOwnPropertySymbols) {
      var o = Object.getOwnPropertySymbols(e);
      r && (o = o.filter(function(r$1) {
        return Object.getOwnPropertyDescriptor(e, r$1).enumerable;
      })), t.push.apply(t, o);
    }
    return t;
  }
  function _objectSpread2(e) {
    for (var r = 1;r < arguments.length; r++) {
      var t = arguments[r] != null ? arguments[r] : {};
      r % 2 ? ownKeys(Object(t), true).forEach(function(r$1) {
        defineProperty(e, r$1, t[r$1]);
      }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function(r$1) {
        Object.defineProperty(e, r$1, Object.getOwnPropertyDescriptor(t, r$1));
      });
    }
    return e;
  }
  module.exports = _objectSpread2, module.exports.__esModule = true, module.exports["default"] = module.exports;
} });

// ../node_modules/@trpc/server/dist/observable-UMO3vUa_.mjs
function observable(subscribe) {
  const self2 = {
    subscribe(observer) {
      let teardownRef = null;
      let isDone = false;
      let unsubscribed = false;
      let teardownImmediately = false;
      function unsubscribe() {
        if (teardownRef === null) {
          teardownImmediately = true;
          return;
        }
        if (unsubscribed)
          return;
        unsubscribed = true;
        if (typeof teardownRef === "function")
          teardownRef();
        else if (teardownRef)
          teardownRef.unsubscribe();
      }
      teardownRef = subscribe({
        next(value) {
          var _observer$next;
          if (isDone)
            return;
          (_observer$next = observer.next) === null || _observer$next === undefined || _observer$next.call(observer, value);
        },
        error(err) {
          var _observer$error;
          if (isDone)
            return;
          isDone = true;
          (_observer$error = observer.error) === null || _observer$error === undefined || _observer$error.call(observer, err);
          unsubscribe();
        },
        complete() {
          var _observer$complete;
          if (isDone)
            return;
          isDone = true;
          (_observer$complete = observer.complete) === null || _observer$complete === undefined || _observer$complete.call(observer);
          unsubscribe();
        }
      });
      if (teardownImmediately)
        unsubscribe();
      return { unsubscribe };
    },
    pipe(...operations) {
      return operations.reduce(pipeReducer, self2);
    }
  };
  return self2;
}
function pipeReducer(prev, fn) {
  return fn(prev);
}
function observableToPromise(observable$1) {
  const ac = new AbortController;
  const promise = new Promise((resolve, reject) => {
    let isDone = false;
    function onDone() {
      if (isDone)
        return;
      isDone = true;
      obs$.unsubscribe();
    }
    ac.signal.addEventListener("abort", () => {
      reject(ac.signal.reason);
    });
    const obs$ = observable$1.subscribe({
      next(data) {
        isDone = true;
        resolve(data);
        onDone();
      },
      error(data) {
        reject(data);
      },
      complete() {
        ac.abort();
        onDone();
      }
    });
  });
  return promise;
}

// ../node_modules/@trpc/server/dist/observable-CUiPknO-.mjs
function share(_opts) {
  return (source) => {
    let refCount = 0;
    let subscription = null;
    const observers = [];
    function startIfNeeded() {
      if (subscription)
        return;
      subscription = source.subscribe({
        next(value) {
          for (const observer of observers) {
            var _observer$next;
            (_observer$next = observer.next) === null || _observer$next === undefined || _observer$next.call(observer, value);
          }
        },
        error(error) {
          for (const observer of observers) {
            var _observer$error;
            (_observer$error = observer.error) === null || _observer$error === undefined || _observer$error.call(observer, error);
          }
        },
        complete() {
          for (const observer of observers) {
            var _observer$complete;
            (_observer$complete = observer.complete) === null || _observer$complete === undefined || _observer$complete.call(observer);
          }
        }
      });
    }
    function resetIfNeeded() {
      if (refCount === 0 && subscription) {
        const _sub = subscription;
        subscription = null;
        _sub.unsubscribe();
      }
    }
    return observable((subscriber) => {
      refCount++;
      observers.push(subscriber);
      startIfNeeded();
      return { unsubscribe() {
        refCount--;
        resetIfNeeded();
        const index = observers.findIndex((v) => v === subscriber);
        if (index > -1)
          observers.splice(index, 1);
      } };
    });
  };
}
var distinctUnsetMarker = Symbol();
function behaviorSubject(initialValue) {
  let value = initialValue;
  const observerList = [];
  const addObserver = (observer) => {
    if (value !== undefined)
      observer.next(value);
    observerList.push(observer);
  };
  const removeObserver = (observer) => {
    observerList.splice(observerList.indexOf(observer), 1);
  };
  const obs = observable((observer) => {
    addObserver(observer);
    return () => {
      removeObserver(observer);
    };
  });
  obs.next = (nextValue) => {
    if (value === nextValue)
      return;
    value = nextValue;
    for (const observer of observerList)
      observer.next(nextValue);
  };
  obs.get = () => value;
  return obs;
}

// ../node_modules/@trpc/client/dist/splitLink-B7Cuf2c_.mjs
function createChain(opts) {
  return observable((observer) => {
    function execute(index = 0, op = opts.op) {
      const next = opts.links[index];
      if (!next)
        throw new Error("No more links to execute - did you forget to add an ending link?");
      const subscription = next({
        op,
        next(nextOp) {
          const nextObserver = execute(index + 1, nextOp);
          return nextObserver;
        }
      });
      return subscription;
    }
    const obs$ = execute();
    return obs$.subscribe(observer);
  });
}

// ../node_modules/@trpc/server/dist/codes-DagpWZLc.mjs
function isObject(value) {
  return !!value && !Array.isArray(value) && typeof value === "object";
}
function emptyObject() {
  return Object.create(null);
}
var TRPC_ERROR_CODES_BY_KEY = {
  PARSE_ERROR: -32700,
  BAD_REQUEST: -32600,
  INTERNAL_SERVER_ERROR: -32603,
  NOT_IMPLEMENTED: -32603,
  BAD_GATEWAY: -32603,
  SERVICE_UNAVAILABLE: -32603,
  GATEWAY_TIMEOUT: -32603,
  UNAUTHORIZED: -32001,
  PAYMENT_REQUIRED: -32002,
  FORBIDDEN: -32003,
  NOT_FOUND: -32004,
  METHOD_NOT_SUPPORTED: -32005,
  TIMEOUT: -32008,
  CONFLICT: -32009,
  PRECONDITION_FAILED: -32012,
  PAYLOAD_TOO_LARGE: -32013,
  UNSUPPORTED_MEDIA_TYPE: -32015,
  UNPROCESSABLE_CONTENT: -32022,
  PRECONDITION_REQUIRED: -32028,
  TOO_MANY_REQUESTS: -32029,
  CLIENT_CLOSED_REQUEST: -32099
};
var retryableRpcCodes = [
  TRPC_ERROR_CODES_BY_KEY.BAD_GATEWAY,
  TRPC_ERROR_CODES_BY_KEY.SERVICE_UNAVAILABLE,
  TRPC_ERROR_CODES_BY_KEY.GATEWAY_TIMEOUT,
  TRPC_ERROR_CODES_BY_KEY.INTERNAL_SERVER_ERROR
];

// ../node_modules/@trpc/server/dist/getErrorShape-vC8mUXJD.mjs
var __create3 = Object.create;
var __defProp3 = Object.defineProperty;
var __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
var __getOwnPropNames3 = Object.getOwnPropertyNames;
var __getProtoOf3 = Object.getPrototypeOf;
var __hasOwnProp3 = Object.prototype.hasOwnProperty;
var __commonJS3 = (cb, mod) => function() {
  return mod || (0, cb[__getOwnPropNames3(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps2 = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function")
    for (var keys = __getOwnPropNames3(from), i = 0, n = keys.length, key;i < n; i++) {
      key = keys[i];
      if (!__hasOwnProp3.call(to, key) && key !== except)
        __defProp3(to, key, {
          get: ((k) => from[k]).bind(null, key),
          enumerable: !(desc = __getOwnPropDesc2(from, key)) || desc.enumerable
        });
    }
  return to;
};
var __toESM3 = (mod, isNodeMode, target) => (target = mod != null ? __create3(__getProtoOf3(mod)) : {}, __copyProps2(isNodeMode || !mod || !mod.__esModule ? __defProp3(target, "default", {
  value: mod,
  enumerable: true
}) : target, mod));
var noop = () => {};
var freezeIfAvailable = (obj) => {
  if (Object.freeze)
    Object.freeze(obj);
};
function createInnerProxy(callback, path, memo) {
  var _memo$cacheKey;
  const cacheKey = path.join(".");
  (_memo$cacheKey = memo[cacheKey]) !== null && _memo$cacheKey !== undefined || (memo[cacheKey] = new Proxy(noop, {
    get(_obj, key) {
      if (typeof key !== "string" || key === "then")
        return;
      return createInnerProxy(callback, [...path, key], memo);
    },
    apply(_1, _2, args) {
      const lastOfPath = path[path.length - 1];
      let opts = {
        args,
        path
      };
      if (lastOfPath === "call")
        opts = {
          args: args.length >= 2 ? [args[1]] : [],
          path: path.slice(0, -1)
        };
      else if (lastOfPath === "apply")
        opts = {
          args: args.length >= 2 ? args[1] : [],
          path: path.slice(0, -1)
        };
      freezeIfAvailable(opts.args);
      freezeIfAvailable(opts.path);
      return callback(opts);
    }
  }));
  return memo[cacheKey];
}
var createRecursiveProxy = (callback) => createInnerProxy(callback, [], emptyObject());
var createFlatProxy = (callback) => {
  return new Proxy(noop, { get(_obj, name) {
    if (name === "then")
      return;
    return callback(name);
  } });
};
var require_typeof2 = __commonJS3({ "../../node_modules/.pnpm/@oxc-project+runtime@0.72.2/node_modules/@oxc-project/runtime/src/helpers/typeof.js"(exports, module) {
  function _typeof$2(o) {
    "@babel/helpers - typeof";
    return module.exports = _typeof$2 = typeof Symbol == "function" && typeof Symbol.iterator == "symbol" ? function(o$1) {
      return typeof o$1;
    } : function(o$1) {
      return o$1 && typeof Symbol == "function" && o$1.constructor === Symbol && o$1 !== Symbol.prototype ? "symbol" : typeof o$1;
    }, module.exports.__esModule = true, module.exports["default"] = module.exports, _typeof$2(o);
  }
  module.exports = _typeof$2, module.exports.__esModule = true, module.exports["default"] = module.exports;
} });
var require_toPrimitive2 = __commonJS3({ "../../node_modules/.pnpm/@oxc-project+runtime@0.72.2/node_modules/@oxc-project/runtime/src/helpers/toPrimitive.js"(exports, module) {
  var _typeof$1 = require_typeof2()["default"];
  function toPrimitive$1(t, r) {
    if (_typeof$1(t) != "object" || !t)
      return t;
    var e = t[Symbol.toPrimitive];
    if (e !== undefined) {
      var i = e.call(t, r || "default");
      if (_typeof$1(i) != "object")
        return i;
      throw new TypeError("@@toPrimitive must return a primitive value.");
    }
    return (r === "string" ? String : Number)(t);
  }
  module.exports = toPrimitive$1, module.exports.__esModule = true, module.exports["default"] = module.exports;
} });
var require_toPropertyKey2 = __commonJS3({ "../../node_modules/.pnpm/@oxc-project+runtime@0.72.2/node_modules/@oxc-project/runtime/src/helpers/toPropertyKey.js"(exports, module) {
  var _typeof = require_typeof2()["default"];
  var toPrimitive = require_toPrimitive2();
  function toPropertyKey$1(t) {
    var i = toPrimitive(t, "string");
    return _typeof(i) == "symbol" ? i : i + "";
  }
  module.exports = toPropertyKey$1, module.exports.__esModule = true, module.exports["default"] = module.exports;
} });
var require_defineProperty2 = __commonJS3({ "../../node_modules/.pnpm/@oxc-project+runtime@0.72.2/node_modules/@oxc-project/runtime/src/helpers/defineProperty.js"(exports, module) {
  var toPropertyKey = require_toPropertyKey2();
  function _defineProperty(e, r, t) {
    return (r = toPropertyKey(r)) in e ? Object.defineProperty(e, r, {
      value: t,
      enumerable: true,
      configurable: true,
      writable: true
    }) : e[r] = t, e;
  }
  module.exports = _defineProperty, module.exports.__esModule = true, module.exports["default"] = module.exports;
} });
var require_objectSpread22 = __commonJS3({ "../../node_modules/.pnpm/@oxc-project+runtime@0.72.2/node_modules/@oxc-project/runtime/src/helpers/objectSpread2.js"(exports, module) {
  var defineProperty = require_defineProperty2();
  function ownKeys(e, r) {
    var t = Object.keys(e);
    if (Object.getOwnPropertySymbols) {
      var o = Object.getOwnPropertySymbols(e);
      r && (o = o.filter(function(r$1) {
        return Object.getOwnPropertyDescriptor(e, r$1).enumerable;
      })), t.push.apply(t, o);
    }
    return t;
  }
  function _objectSpread2(e) {
    for (var r = 1;r < arguments.length; r++) {
      var t = arguments[r] != null ? arguments[r] : {};
      r % 2 ? ownKeys(Object(t), true).forEach(function(r$1) {
        defineProperty(e, r$1, t[r$1]);
      }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function(r$1) {
        Object.defineProperty(e, r$1, Object.getOwnPropertyDescriptor(t, r$1));
      });
    }
    return e;
  }
  module.exports = _objectSpread2, module.exports.__esModule = true, module.exports["default"] = module.exports;
} });
var import_objectSpread2 = __toESM3(require_objectSpread22(), 1);

// ../node_modules/@trpc/server/dist/tracked-Bjtgv3wJ.mjs
var import_defineProperty = __toESM3(require_defineProperty2(), 1);
var import_objectSpread2$1 = __toESM3(require_objectSpread22(), 1);
function transformResultInner(response, transformer) {
  if ("error" in response) {
    const error = transformer.deserialize(response.error);
    return {
      ok: false,
      error: (0, import_objectSpread2$1.default)((0, import_objectSpread2$1.default)({}, response), {}, { error })
    };
  }
  const result = (0, import_objectSpread2$1.default)((0, import_objectSpread2$1.default)({}, response.result), (!response.result.type || response.result.type === "data") && {
    type: "data",
    data: transformer.deserialize(response.result.data)
  });
  return {
    ok: true,
    result
  };
}
var TransformResultError = class extends Error {
  constructor() {
    super("Unable to transform response from server");
  }
};
function transformResult(response, transformer) {
  let result;
  try {
    result = transformResultInner(response, transformer);
  } catch (_unused) {
    throw new TransformResultError;
  }
  if (!result.ok && (!isObject(result.error.error) || typeof result.error.error["code"] !== "number"))
    throw new TransformResultError;
  if (result.ok && !isObject(result.result))
    throw new TransformResultError;
  return result;
}
var import_objectSpread22 = __toESM3(require_objectSpread22(), 1);
var trackedSymbol = Symbol();

// ../node_modules/@trpc/client/dist/TRPCClientError-apv8gw59.mjs
var import_defineProperty2 = __toESM2(require_defineProperty(), 1);
var import_objectSpread23 = __toESM2(require_objectSpread2(), 1);
function isTRPCClientError(cause) {
  return cause instanceof TRPCClientError;
}
function isTRPCErrorResponse(obj) {
  return isObject(obj) && isObject(obj["error"]) && typeof obj["error"]["code"] === "number" && typeof obj["error"]["message"] === "string";
}
function getMessageFromUnknownError(err, fallback) {
  if (typeof err === "string")
    return err;
  if (isObject(err) && typeof err["message"] === "string")
    return err["message"];
  return fallback;
}
var TRPCClientError = class TRPCClientError2 extends Error {
  constructor(message, opts) {
    var _opts$result, _opts$result2;
    const cause = opts === null || opts === undefined ? undefined : opts.cause;
    super(message, { cause });
    (0, import_defineProperty2.default)(this, "cause", undefined);
    (0, import_defineProperty2.default)(this, "shape", undefined);
    (0, import_defineProperty2.default)(this, "data", undefined);
    (0, import_defineProperty2.default)(this, "meta", undefined);
    this.meta = opts === null || opts === undefined ? undefined : opts.meta;
    this.cause = cause;
    this.shape = opts === null || opts === undefined || (_opts$result = opts.result) === null || _opts$result === undefined ? undefined : _opts$result.error;
    this.data = opts === null || opts === undefined || (_opts$result2 = opts.result) === null || _opts$result2 === undefined ? undefined : _opts$result2.error.data;
    this.name = "TRPCClientError";
    Object.setPrototypeOf(this, TRPCClientError2.prototype);
  }
  static from(_cause, opts = {}) {
    const cause = _cause;
    if (isTRPCClientError(cause)) {
      if (opts.meta)
        cause.meta = (0, import_objectSpread23.default)((0, import_objectSpread23.default)({}, cause.meta), opts.meta);
      return cause;
    }
    if (isTRPCErrorResponse(cause))
      return new TRPCClientError2(cause.error.message, (0, import_objectSpread23.default)((0, import_objectSpread23.default)({}, opts), {}, {
        result: cause,
        cause: opts.cause
      }));
    return new TRPCClientError2(getMessageFromUnknownError(cause, "Unknown error"), (0, import_objectSpread23.default)((0, import_objectSpread23.default)({}, opts), {}, { cause }));
  }
};

// ../node_modules/@trpc/client/dist/unstable-internals-Bg7n9BBj.mjs
function getTransformer(transformer) {
  const _transformer = transformer;
  if (!_transformer)
    return {
      input: {
        serialize: (data) => data,
        deserialize: (data) => data
      },
      output: {
        serialize: (data) => data,
        deserialize: (data) => data
      }
    };
  if ("input" in _transformer)
    return _transformer;
  return {
    input: _transformer,
    output: _transformer
  };
}

// ../node_modules/@trpc/client/dist/httpUtils-pyf5RF99.mjs
var isFunction2 = (fn) => typeof fn === "function";
function getFetch(customFetchImpl) {
  if (customFetchImpl)
    return customFetchImpl;
  if (typeof window !== "undefined" && isFunction2(window.fetch))
    return window.fetch;
  if (typeof globalThis !== "undefined" && isFunction2(globalThis.fetch))
    return globalThis.fetch;
  throw new Error("No fetch implementation found");
}
var import_objectSpread24 = __toESM2(require_objectSpread2(), 1);
function resolveHTTPLinkOptions(opts) {
  return {
    url: opts.url.toString(),
    fetch: opts.fetch,
    transformer: getTransformer(opts.transformer),
    methodOverride: opts.methodOverride
  };
}
function arrayToDict(array) {
  const dict = {};
  for (let index = 0;index < array.length; index++) {
    const element = array[index];
    dict[index] = element;
  }
  return dict;
}
var METHOD = {
  query: "GET",
  mutation: "POST",
  subscription: "PATCH"
};
function getInput(opts) {
  return "input" in opts ? opts.transformer.input.serialize(opts.input) : arrayToDict(opts.inputs.map((_input) => opts.transformer.input.serialize(_input)));
}
var getUrl = (opts) => {
  const parts = opts.url.split("?");
  const base = parts[0].replace(/\/$/, "");
  let url = base + "/" + opts.path;
  const queryParts = [];
  if (parts[1])
    queryParts.push(parts[1]);
  if ("inputs" in opts)
    queryParts.push("batch=1");
  if (opts.type === "query" || opts.type === "subscription") {
    const input = getInput(opts);
    if (input !== undefined && opts.methodOverride !== "POST")
      queryParts.push(`input=${encodeURIComponent(JSON.stringify(input))}`);
  }
  if (queryParts.length)
    url += "?" + queryParts.join("&");
  return url;
};
var getBody = (opts) => {
  if (opts.type === "query" && opts.methodOverride !== "POST")
    return;
  const input = getInput(opts);
  return input !== undefined ? JSON.stringify(input) : undefined;
};
var jsonHttpRequester = (opts) => {
  return httpRequest((0, import_objectSpread24.default)((0, import_objectSpread24.default)({}, opts), {}, {
    contentTypeHeader: "application/json",
    getUrl,
    getBody
  }));
};
var AbortError = class extends Error {
  constructor() {
    const name = "AbortError";
    super(name);
    this.name = name;
    this.message = name;
  }
};
var throwIfAborted = (signal) => {
  var _signal$throwIfAborte;
  if (!(signal === null || signal === undefined ? undefined : signal.aborted))
    return;
  (_signal$throwIfAborte = signal.throwIfAborted) === null || _signal$throwIfAborte === undefined || _signal$throwIfAborte.call(signal);
  if (typeof DOMException !== "undefined")
    throw new DOMException("AbortError", "AbortError");
  throw new AbortError;
};
async function fetchHTTPResponse(opts) {
  var _opts$methodOverride, _opts$trpcAcceptHeade;
  throwIfAborted(opts.signal);
  const url = opts.getUrl(opts);
  const body = opts.getBody(opts);
  const method = (_opts$methodOverride = opts.methodOverride) !== null && _opts$methodOverride !== undefined ? _opts$methodOverride : METHOD[opts.type];
  const resolvedHeaders = await (async () => {
    const heads = await opts.headers();
    if (Symbol.iterator in heads)
      return Object.fromEntries(heads);
    return heads;
  })();
  const headers = (0, import_objectSpread24.default)((0, import_objectSpread24.default)((0, import_objectSpread24.default)({}, opts.contentTypeHeader && method !== "GET" ? { "content-type": opts.contentTypeHeader } : {}), opts.trpcAcceptHeader ? { [(_opts$trpcAcceptHeade = opts.trpcAcceptHeaderKey) !== null && _opts$trpcAcceptHeade !== undefined ? _opts$trpcAcceptHeade : "trpc-accept"]: opts.trpcAcceptHeader } : undefined), resolvedHeaders);
  return getFetch(opts.fetch)(url, {
    method,
    signal: opts.signal,
    body,
    headers
  });
}
async function httpRequest(opts) {
  const meta = {};
  const res = await fetchHTTPResponse(opts);
  meta.response = res;
  const json = await res.json();
  meta.responseJSON = json;
  return {
    json,
    meta
  };
}

// ../node_modules/@trpc/client/dist/httpLink-lG_6juPY.mjs
var import_objectSpread25 = __toESM2(require_objectSpread2(), 1);

// ../node_modules/@trpc/client/dist/httpBatchLink-LhidKAPw.mjs
var throwFatalError = () => {
  throw new Error("Something went wrong. Please submit an issue at https://github.com/trpc/trpc/issues/new");
};
function dataLoader(batchLoader) {
  let pendingItems = null;
  let dispatchTimer = null;
  const destroyTimerAndPendingItems = () => {
    clearTimeout(dispatchTimer);
    dispatchTimer = null;
    pendingItems = null;
  };
  function groupItems(items) {
    const groupedItems = [[]];
    let index = 0;
    while (true) {
      const item = items[index];
      if (!item)
        break;
      const lastGroup = groupedItems[groupedItems.length - 1];
      if (item.aborted) {
        var _item$reject;
        (_item$reject = item.reject) === null || _item$reject === undefined || _item$reject.call(item, new Error("Aborted"));
        index++;
        continue;
      }
      const isValid = batchLoader.validate(lastGroup.concat(item).map((it) => it.key));
      if (isValid) {
        lastGroup.push(item);
        index++;
        continue;
      }
      if (lastGroup.length === 0) {
        var _item$reject2;
        (_item$reject2 = item.reject) === null || _item$reject2 === undefined || _item$reject2.call(item, new Error("Input is too big for a single dispatch"));
        index++;
        continue;
      }
      groupedItems.push([]);
    }
    return groupedItems;
  }
  function dispatch() {
    const groupedItems = groupItems(pendingItems);
    destroyTimerAndPendingItems();
    for (const items of groupedItems) {
      if (!items.length)
        continue;
      const batch = { items };
      for (const item of items)
        item.batch = batch;
      const promise = batchLoader.fetch(batch.items.map((_item) => _item.key));
      promise.then(async (result) => {
        await Promise.all(result.map(async (valueOrPromise, index) => {
          const item = batch.items[index];
          try {
            var _item$resolve;
            const value = await Promise.resolve(valueOrPromise);
            (_item$resolve = item.resolve) === null || _item$resolve === undefined || _item$resolve.call(item, value);
          } catch (cause) {
            var _item$reject3;
            (_item$reject3 = item.reject) === null || _item$reject3 === undefined || _item$reject3.call(item, cause);
          }
          item.batch = null;
          item.reject = null;
          item.resolve = null;
        }));
        for (const item of batch.items) {
          var _item$reject4;
          (_item$reject4 = item.reject) === null || _item$reject4 === undefined || _item$reject4.call(item, new Error("Missing result"));
          item.batch = null;
        }
      }).catch((cause) => {
        for (const item of batch.items) {
          var _item$reject5;
          (_item$reject5 = item.reject) === null || _item$reject5 === undefined || _item$reject5.call(item, cause);
          item.batch = null;
        }
      });
    }
  }
  function load(key) {
    var _dispatchTimer;
    const item = {
      aborted: false,
      key,
      batch: null,
      resolve: throwFatalError,
      reject: throwFatalError
    };
    const promise = new Promise((resolve, reject) => {
      var _pendingItems;
      item.reject = reject;
      item.resolve = resolve;
      (_pendingItems = pendingItems) !== null && _pendingItems !== undefined || (pendingItems = []);
      pendingItems.push(item);
    });
    (_dispatchTimer = dispatchTimer) !== null && _dispatchTimer !== undefined || (dispatchTimer = setTimeout(dispatch));
    return promise;
  }
  return { load };
}
function allAbortSignals(...signals) {
  const ac = new AbortController;
  const count = signals.length;
  let abortedCount = 0;
  const onAbort = () => {
    if (++abortedCount === count)
      ac.abort();
  };
  for (const signal of signals)
    if (signal === null || signal === undefined ? undefined : signal.aborted)
      onAbort();
    else
      signal === null || signal === undefined || signal.addEventListener("abort", onAbort, { once: true });
  return ac.signal;
}
var import_objectSpread26 = __toESM2(require_objectSpread2(), 1);
function httpBatchLink(opts) {
  var _opts$maxURLLength, _opts$maxItems;
  const resolvedOpts = resolveHTTPLinkOptions(opts);
  const maxURLLength = (_opts$maxURLLength = opts.maxURLLength) !== null && _opts$maxURLLength !== undefined ? _opts$maxURLLength : Infinity;
  const maxItems = (_opts$maxItems = opts.maxItems) !== null && _opts$maxItems !== undefined ? _opts$maxItems : Infinity;
  return () => {
    const batchLoader = (type) => {
      return {
        validate(batchOps) {
          if (maxURLLength === Infinity && maxItems === Infinity)
            return true;
          if (batchOps.length > maxItems)
            return false;
          const path = batchOps.map((op) => op.path).join(",");
          const inputs = batchOps.map((op) => op.input);
          const url = getUrl((0, import_objectSpread26.default)((0, import_objectSpread26.default)({}, resolvedOpts), {}, {
            type,
            path,
            inputs,
            signal: null
          }));
          return url.length <= maxURLLength;
        },
        async fetch(batchOps) {
          const path = batchOps.map((op) => op.path).join(",");
          const inputs = batchOps.map((op) => op.input);
          const signal = allAbortSignals(...batchOps.map((op) => op.signal));
          const res = await jsonHttpRequester((0, import_objectSpread26.default)((0, import_objectSpread26.default)({}, resolvedOpts), {}, {
            path,
            inputs,
            type,
            headers() {
              if (!opts.headers)
                return {};
              if (typeof opts.headers === "function")
                return opts.headers({ opList: batchOps });
              return opts.headers;
            },
            signal
          }));
          const resJSON = Array.isArray(res.json) ? res.json : batchOps.map(() => res.json);
          const result = resJSON.map((item) => ({
            meta: res.meta,
            json: item
          }));
          return result;
        }
      };
    };
    const query = dataLoader(batchLoader("query"));
    const mutation = dataLoader(batchLoader("mutation"));
    const loaders = {
      query,
      mutation
    };
    return ({ op }) => {
      return observable((observer) => {
        if (op.type === "subscription")
          throw new Error("Subscriptions are unsupported by `httpLink` - use `httpSubscriptionLink` or `wsLink`");
        const loader = loaders[op.type];
        const promise = loader.load(op);
        let _res = undefined;
        promise.then((res) => {
          _res = res;
          const transformed = transformResult(res.json, resolvedOpts.transformer.output);
          if (!transformed.ok) {
            observer.error(TRPCClientError.from(transformed.error, { meta: res.meta }));
            return;
          }
          observer.next({
            context: res.meta,
            result: transformed.result
          });
          observer.complete();
        }).catch((err) => {
          observer.error(TRPCClientError.from(err, { meta: _res === null || _res === undefined ? undefined : _res.meta }));
        });
        return () => {};
      });
    };
  };
}

// ../node_modules/@trpc/client/dist/loggerLink-ineCN1PO.mjs
var import_objectSpread27 = __toESM2(require_objectSpread2(), 1);

// ../node_modules/@trpc/client/dist/wsLink-DSf4KOdW.mjs
var resultOf = (value, ...args) => {
  return typeof value === "function" ? value(...args) : value;
};
var import_defineProperty$3 = __toESM2(require_defineProperty(), 1);
function withResolvers() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve,
    reject
  };
}
async function prepareUrl(urlOptions) {
  const url = await resultOf(urlOptions.url);
  if (!urlOptions.connectionParams)
    return url;
  const prefix = url.includes("?") ? "&" : "?";
  const connectionParams = `${prefix}connectionParams=1`;
  return url + connectionParams;
}
async function buildConnectionMessage(connectionParams, encoder) {
  const message = {
    method: "connectionParams",
    data: await resultOf(connectionParams)
  };
  return encoder.encode(message);
}
var import_defineProperty$2 = __toESM2(require_defineProperty(), 1);
var import_defineProperty$1 = __toESM2(require_defineProperty(), 1);
function asyncWsOpen(ws) {
  const { promise, resolve, reject } = withResolvers();
  ws.addEventListener("open", () => {
    ws.removeEventListener("error", reject);
    resolve();
  });
  ws.addEventListener("error", reject);
  return promise;
}
function setupPingInterval(ws, { intervalMs, pongTimeoutMs }) {
  let pingTimeout;
  let pongTimeout;
  function start() {
    pingTimeout = setTimeout(() => {
      ws.send("PING");
      pongTimeout = setTimeout(() => {
        ws.close();
      }, pongTimeoutMs);
    }, intervalMs);
  }
  function reset() {
    clearTimeout(pingTimeout);
    start();
  }
  function pong() {
    clearTimeout(pongTimeout);
    reset();
  }
  ws.addEventListener("open", start);
  ws.addEventListener("message", ({ data }) => {
    clearTimeout(pingTimeout);
    start();
    if (data === "PONG")
      pong();
  });
  ws.addEventListener("close", () => {
    clearTimeout(pingTimeout);
    clearTimeout(pongTimeout);
  });
}
var WsConnection = class WsConnection2 {
  constructor(opts) {
    var _opts$WebSocketPonyfi;
    (0, import_defineProperty$1.default)(this, "id", ++WsConnection2.connectCount);
    (0, import_defineProperty$1.default)(this, "WebSocketPonyfill", undefined);
    (0, import_defineProperty$1.default)(this, "urlOptions", undefined);
    (0, import_defineProperty$1.default)(this, "keepAliveOpts", undefined);
    (0, import_defineProperty$1.default)(this, "encoder", undefined);
    (0, import_defineProperty$1.default)(this, "wsObservable", behaviorSubject(null));
    (0, import_defineProperty$1.default)(this, "openPromise", null);
    this.WebSocketPonyfill = (_opts$WebSocketPonyfi = opts.WebSocketPonyfill) !== null && _opts$WebSocketPonyfi !== undefined ? _opts$WebSocketPonyfi : WebSocket;
    if (!this.WebSocketPonyfill)
      throw new Error("No WebSocket implementation found - you probably don't want to use this on the server, but if you do you need to pass a `WebSocket`-ponyfill");
    this.urlOptions = opts.urlOptions;
    this.keepAliveOpts = opts.keepAlive;
    this.encoder = opts.encoder;
  }
  get ws() {
    return this.wsObservable.get();
  }
  set ws(ws) {
    this.wsObservable.next(ws);
  }
  isOpen() {
    return !!this.ws && this.ws.readyState === this.WebSocketPonyfill.OPEN && !this.openPromise;
  }
  isClosed() {
    return !!this.ws && (this.ws.readyState === this.WebSocketPonyfill.CLOSING || this.ws.readyState === this.WebSocketPonyfill.CLOSED);
  }
  async open() {
    var _this = this;
    if (_this.openPromise)
      return _this.openPromise;
    _this.id = ++WsConnection2.connectCount;
    const wsPromise = prepareUrl(_this.urlOptions).then((url) => new _this.WebSocketPonyfill(url));
    _this.openPromise = wsPromise.then(async (ws) => {
      _this.ws = ws;
      ws.binaryType = "arraybuffer";
      ws.addEventListener("message", function({ data }) {
        if (data === "PING")
          this.send("PONG");
      });
      if (_this.keepAliveOpts.enabled)
        setupPingInterval(ws, _this.keepAliveOpts);
      ws.addEventListener("close", () => {
        if (_this.ws === ws)
          _this.ws = null;
      });
      await asyncWsOpen(ws);
      if (_this.urlOptions.connectionParams)
        ws.send(await buildConnectionMessage(_this.urlOptions.connectionParams, _this.encoder));
    });
    try {
      await _this.openPromise;
    } finally {
      _this.openPromise = null;
    }
  }
  async close() {
    var _this2 = this;
    try {
      await _this2.openPromise;
    } finally {
      var _this$ws;
      (_this$ws = _this2.ws) === null || _this$ws === undefined || _this$ws.close();
    }
  }
};
(0, import_defineProperty$1.default)(WsConnection, "connectCount", 0);
var import_defineProperty3 = __toESM2(require_defineProperty(), 1);
var import_objectSpread28 = __toESM2(require_objectSpread2(), 1);

// ../node_modules/@trpc/client/dist/index.mjs
var import_defineProperty4 = __toESM2(require_defineProperty(), 1);
var import_objectSpread2$4 = __toESM2(require_objectSpread2(), 1);
var TRPCUntypedClient = class {
  constructor(opts) {
    (0, import_defineProperty4.default)(this, "links", undefined);
    (0, import_defineProperty4.default)(this, "runtime", undefined);
    (0, import_defineProperty4.default)(this, "requestId", undefined);
    this.requestId = 0;
    this.runtime = {};
    this.links = opts.links.map((link) => link(this.runtime));
  }
  $request(opts) {
    var _opts$context;
    const chain$ = createChain({
      links: this.links,
      op: (0, import_objectSpread2$4.default)((0, import_objectSpread2$4.default)({}, opts), {}, {
        context: (_opts$context = opts.context) !== null && _opts$context !== undefined ? _opts$context : {},
        id: ++this.requestId
      })
    });
    return chain$.pipe(share());
  }
  async requestAsPromise(opts) {
    var _this = this;
    try {
      const req$ = _this.$request(opts);
      const envelope = await observableToPromise(req$);
      const data = envelope.result.data;
      return data;
    } catch (err) {
      throw TRPCClientError.from(err);
    }
  }
  query(path, input, opts) {
    return this.requestAsPromise({
      type: "query",
      path,
      input,
      context: opts === null || opts === undefined ? undefined : opts.context,
      signal: opts === null || opts === undefined ? undefined : opts.signal
    });
  }
  mutation(path, input, opts) {
    return this.requestAsPromise({
      type: "mutation",
      path,
      input,
      context: opts === null || opts === undefined ? undefined : opts.context,
      signal: opts === null || opts === undefined ? undefined : opts.signal
    });
  }
  subscription(path, input, opts) {
    const observable$ = this.$request({
      type: "subscription",
      path,
      input,
      context: opts.context,
      signal: opts.signal
    });
    return observable$.subscribe({
      next(envelope) {
        switch (envelope.result.type) {
          case "state": {
            var _opts$onConnectionSta;
            (_opts$onConnectionSta = opts.onConnectionStateChange) === null || _opts$onConnectionSta === undefined || _opts$onConnectionSta.call(opts, envelope.result);
            break;
          }
          case "started": {
            var _opts$onStarted;
            (_opts$onStarted = opts.onStarted) === null || _opts$onStarted === undefined || _opts$onStarted.call(opts, { context: envelope.context });
            break;
          }
          case "stopped": {
            var _opts$onStopped;
            (_opts$onStopped = opts.onStopped) === null || _opts$onStopped === undefined || _opts$onStopped.call(opts);
            break;
          }
          case "data":
          case undefined: {
            var _opts$onData;
            (_opts$onData = opts.onData) === null || _opts$onData === undefined || _opts$onData.call(opts, envelope.result.data);
            break;
          }
        }
      },
      error(err) {
        var _opts$onError;
        (_opts$onError = opts.onError) === null || _opts$onError === undefined || _opts$onError.call(opts, err);
      },
      complete() {
        var _opts$onComplete;
        (_opts$onComplete = opts.onComplete) === null || _opts$onComplete === undefined || _opts$onComplete.call(opts);
      }
    });
  }
};
var untypedClientSymbol = Symbol.for("trpc_untypedClient");
var clientCallTypeMap = {
  query: "query",
  mutate: "mutation",
  subscribe: "subscription"
};
var clientCallTypeToProcedureType = (clientCallType) => {
  return clientCallTypeMap[clientCallType];
};
function createTRPCClientProxy(client) {
  const proxy = createRecursiveProxy(({ path, args }) => {
    const pathCopy = [...path];
    const procedureType = clientCallTypeToProcedureType(pathCopy.pop());
    const fullPath = pathCopy.join(".");
    return client[procedureType](fullPath, ...args);
  });
  return createFlatProxy((key) => {
    if (key === untypedClientSymbol)
      return client;
    return proxy[key];
  });
}
function createTRPCClient(opts) {
  const client = new TRPCUntypedClient(opts);
  const proxy = createTRPCClientProxy(client);
  return proxy;
}
var import_objectSpread2$3 = __toESM2(require_objectSpread2(), 1);
var import_objectSpread2$2 = __toESM2(require_objectSpread2(), 1);
var require_asyncIterator = __commonJS2({ "../../node_modules/.pnpm/@oxc-project+runtime@0.72.2/node_modules/@oxc-project/runtime/src/helpers/asyncIterator.js"(exports, module) {
  function _asyncIterator$1(r) {
    var n, t, o, e = 2;
    for (typeof Symbol != "undefined" && (t = Symbol.asyncIterator, o = Symbol.iterator);e--; ) {
      if (t && (n = r[t]) != null)
        return n.call(r);
      if (o && (n = r[o]) != null)
        return new AsyncFromSyncIterator(n.call(r));
      t = "@@asyncIterator", o = "@@iterator";
    }
    throw new TypeError("Object is not async iterable");
  }
  function AsyncFromSyncIterator(r) {
    function AsyncFromSyncIteratorContinuation(r$1) {
      if (Object(r$1) !== r$1)
        return Promise.reject(new TypeError(r$1 + " is not an object."));
      var n = r$1.done;
      return Promise.resolve(r$1.value).then(function(r$2) {
        return {
          value: r$2,
          done: n
        };
      });
    }
    return AsyncFromSyncIterator = function AsyncFromSyncIterator$1(r$1) {
      this.s = r$1, this.n = r$1.next;
    }, AsyncFromSyncIterator.prototype = {
      s: null,
      n: null,
      next: function next() {
        return AsyncFromSyncIteratorContinuation(this.n.apply(this.s, arguments));
      },
      return: function _return(r$1) {
        var n = this.s["return"];
        return n === undefined ? Promise.resolve({
          value: r$1,
          done: true
        }) : AsyncFromSyncIteratorContinuation(n.apply(this.s, arguments));
      },
      throw: function _throw(r$1) {
        var n = this.s["return"];
        return n === undefined ? Promise.reject(r$1) : AsyncFromSyncIteratorContinuation(n.apply(this.s, arguments));
      }
    }, new AsyncFromSyncIterator(r);
  }
  module.exports = _asyncIterator$1, module.exports.__esModule = true, module.exports["default"] = module.exports;
} });
var import_asyncIterator = __toESM2(require_asyncIterator(), 1);
var import_objectSpread2$12 = __toESM2(require_objectSpread2(), 1);
var require_usingCtx = __commonJS2({ "../../node_modules/.pnpm/@oxc-project+runtime@0.72.2/node_modules/@oxc-project/runtime/src/helpers/usingCtx.js"(exports, module) {
  function _usingCtx() {
    var r = typeof SuppressedError == "function" ? SuppressedError : function(r$1, e$1) {
      var n$1 = Error();
      return n$1.name = "SuppressedError", n$1.error = r$1, n$1.suppressed = e$1, n$1;
    }, e = {}, n = [];
    function using(r$1, e$1) {
      if (e$1 != null) {
        if (Object(e$1) !== e$1)
          throw new TypeError("using declarations can only be used with objects, functions, null, or undefined.");
        if (r$1)
          var o = e$1[Symbol.asyncDispose || Symbol["for"]("Symbol.asyncDispose")];
        if (o === undefined && (o = e$1[Symbol.dispose || Symbol["for"]("Symbol.dispose")], r$1))
          var t = o;
        if (typeof o != "function")
          throw new TypeError("Object is not disposable.");
        t && (o = function o$1() {
          try {
            t.call(e$1);
          } catch (r$2) {
            return Promise.reject(r$2);
          }
        }), n.push({
          v: e$1,
          d: o,
          a: r$1
        });
      } else
        r$1 && n.push({
          d: e$1,
          a: r$1
        });
      return e$1;
    }
    return {
      e,
      u: using.bind(null, false),
      a: using.bind(null, true),
      d: function d() {
        var o, t = this.e, s = 0;
        function next() {
          for (;o = n.pop(); )
            try {
              if (!o.a && s === 1)
                return s = 0, n.push(o), Promise.resolve().then(next);
              if (o.d) {
                var r$1 = o.d.call(o.v);
                if (o.a)
                  return s |= 2, Promise.resolve(r$1).then(next, err);
              } else
                s |= 1;
            } catch (r$2) {
              return err(r$2);
            }
          if (s === 1)
            return t !== e ? Promise.reject(t) : Promise.resolve();
          if (t !== e)
            throw t;
        }
        function err(n$1) {
          return t = t !== e ? new r(n$1, t) : n$1, next();
        }
        return next();
      }
    };
  }
  module.exports = _usingCtx, module.exports.__esModule = true, module.exports["default"] = module.exports;
} });
var require_OverloadYield = __commonJS2({ "../../node_modules/.pnpm/@oxc-project+runtime@0.72.2/node_modules/@oxc-project/runtime/src/helpers/OverloadYield.js"(exports, module) {
  function _OverloadYield(e, d) {
    this.v = e, this.k = d;
  }
  module.exports = _OverloadYield, module.exports.__esModule = true, module.exports["default"] = module.exports;
} });
var require_awaitAsyncGenerator = __commonJS2({ "../../node_modules/.pnpm/@oxc-project+runtime@0.72.2/node_modules/@oxc-project/runtime/src/helpers/awaitAsyncGenerator.js"(exports, module) {
  var OverloadYield$1 = require_OverloadYield();
  function _awaitAsyncGenerator$1(e) {
    return new OverloadYield$1(e, 0);
  }
  module.exports = _awaitAsyncGenerator$1, module.exports.__esModule = true, module.exports["default"] = module.exports;
} });
var require_wrapAsyncGenerator = __commonJS2({ "../../node_modules/.pnpm/@oxc-project+runtime@0.72.2/node_modules/@oxc-project/runtime/src/helpers/wrapAsyncGenerator.js"(exports, module) {
  var OverloadYield = require_OverloadYield();
  function _wrapAsyncGenerator$1(e) {
    return function() {
      return new AsyncGenerator(e.apply(this, arguments));
    };
  }
  function AsyncGenerator(e) {
    var r, t;
    function resume(r$1, t$1) {
      try {
        var n = e[r$1](t$1), o = n.value, u = o instanceof OverloadYield;
        Promise.resolve(u ? o.v : o).then(function(t$2) {
          if (u) {
            var i = r$1 === "return" ? "return" : "next";
            if (!o.k || t$2.done)
              return resume(i, t$2);
            t$2 = e[i](t$2).value;
          }
          settle(n.done ? "return" : "normal", t$2);
        }, function(e$1) {
          resume("throw", e$1);
        });
      } catch (e$1) {
        settle("throw", e$1);
      }
    }
    function settle(e$1, n) {
      switch (e$1) {
        case "return":
          r.resolve({
            value: n,
            done: true
          });
          break;
        case "throw":
          r.reject(n);
          break;
        default:
          r.resolve({
            value: n,
            done: false
          });
      }
      (r = r.next) ? resume(r.key, r.arg) : t = null;
    }
    this._invoke = function(e$1, n) {
      return new Promise(function(o, u) {
        var i = {
          key: e$1,
          arg: n,
          resolve: o,
          reject: u,
          next: null
        };
        t ? t = t.next = i : (r = t = i, resume(e$1, n));
      });
    }, typeof e["return"] != "function" && (this["return"] = undefined);
  }
  AsyncGenerator.prototype[typeof Symbol == "function" && Symbol.asyncIterator || "@@asyncIterator"] = function() {
    return this;
  }, AsyncGenerator.prototype.next = function(e) {
    return this._invoke("next", e);
  }, AsyncGenerator.prototype["throw"] = function(e) {
    return this._invoke("throw", e);
  }, AsyncGenerator.prototype["return"] = function(e) {
    return this._invoke("return", e);
  };
  module.exports = _wrapAsyncGenerator$1, module.exports.__esModule = true, module.exports["default"] = module.exports;
} });
var import_usingCtx = __toESM2(require_usingCtx(), 1);
var import_awaitAsyncGenerator = __toESM2(require_awaitAsyncGenerator(), 1);
var import_wrapAsyncGenerator = __toESM2(require_wrapAsyncGenerator(), 1);
var import_objectSpread29 = __toESM2(require_objectSpread2(), 1);

// ../node_modules/superjson/dist/double-indexed-kv.js
class DoubleIndexedKV {
  constructor() {
    this.keyToValue = new Map;
    this.valueToKey = new Map;
  }
  set(key, value) {
    this.keyToValue.set(key, value);
    this.valueToKey.set(value, key);
  }
  getByKey(key) {
    return this.keyToValue.get(key);
  }
  getByValue(value) {
    return this.valueToKey.get(value);
  }
  clear() {
    this.keyToValue.clear();
    this.valueToKey.clear();
  }
}

// ../node_modules/superjson/dist/registry.js
class Registry {
  constructor(generateIdentifier) {
    this.generateIdentifier = generateIdentifier;
    this.kv = new DoubleIndexedKV;
  }
  register(value, identifier) {
    if (this.kv.getByValue(value)) {
      return;
    }
    if (!identifier) {
      identifier = this.generateIdentifier(value);
    }
    this.kv.set(identifier, value);
  }
  clear() {
    this.kv.clear();
  }
  getIdentifier(value) {
    return this.kv.getByValue(value);
  }
  getValue(identifier) {
    return this.kv.getByKey(identifier);
  }
}

// ../node_modules/superjson/dist/class-registry.js
class ClassRegistry extends Registry {
  constructor() {
    super((c) => c.name);
    this.classToAllowedProps = new Map;
  }
  register(value, options) {
    if (typeof options === "object") {
      if (options.allowProps) {
        this.classToAllowedProps.set(value, options.allowProps);
      }
      super.register(value, options.identifier);
    } else {
      super.register(value, options);
    }
  }
  getAllowedProps(value) {
    return this.classToAllowedProps.get(value);
  }
}

// ../node_modules/superjson/dist/util.js
function valuesOfObj(record) {
  if ("values" in Object) {
    return Object.values(record);
  }
  const values = [];
  for (const key in record) {
    if (record.hasOwnProperty(key)) {
      values.push(record[key]);
    }
  }
  return values;
}
function find(record, predicate) {
  const values = valuesOfObj(record);
  if ("find" in values) {
    return values.find(predicate);
  }
  const valuesNotNever = values;
  for (let i = 0;i < valuesNotNever.length; i++) {
    const value = valuesNotNever[i];
    if (predicate(value)) {
      return value;
    }
  }
  return;
}
function forEach(record, run2) {
  Object.entries(record).forEach(([key, value]) => run2(value, key));
}
function includes(arr, value) {
  return arr.indexOf(value) !== -1;
}
function findArr(record, predicate) {
  for (let i = 0;i < record.length; i++) {
    const value = record[i];
    if (predicate(value)) {
      return value;
    }
  }
  return;
}

// ../node_modules/superjson/dist/custom-transformer-registry.js
class CustomTransformerRegistry {
  constructor() {
    this.transfomers = {};
  }
  register(transformer) {
    this.transfomers[transformer.name] = transformer;
  }
  findApplicable(v) {
    return find(this.transfomers, (transformer) => transformer.isApplicable(v));
  }
  findByName(name) {
    return this.transfomers[name];
  }
}

// ../node_modules/superjson/dist/is.js
var getType = (payload) => Object.prototype.toString.call(payload).slice(8, -1);
var isUndefined = (payload) => typeof payload === "undefined";
var isNull = (payload) => payload === null;
var isPlainObject = (payload) => {
  if (typeof payload !== "object" || payload === null)
    return false;
  if (payload === Object.prototype)
    return false;
  if (Object.getPrototypeOf(payload) === null)
    return true;
  return Object.getPrototypeOf(payload) === Object.prototype;
};
var isEmptyObject = (payload) => isPlainObject(payload) && Object.keys(payload).length === 0;
var isArray = (payload) => Array.isArray(payload);
var isString = (payload) => typeof payload === "string";
var isNumber = (payload) => typeof payload === "number" && !isNaN(payload);
var isBoolean = (payload) => typeof payload === "boolean";
var isRegExp = (payload) => payload instanceof RegExp;
var isMap = (payload) => payload instanceof Map;
var isSet = (payload) => payload instanceof Set;
var isSymbol = (payload) => getType(payload) === "Symbol";
var isDate = (payload) => payload instanceof Date && !isNaN(payload.valueOf());
var isError = (payload) => payload instanceof Error;
var isNaNValue = (payload) => typeof payload === "number" && isNaN(payload);
var isPrimitive = (payload) => isBoolean(payload) || isNull(payload) || isUndefined(payload) || isNumber(payload) || isString(payload) || isSymbol(payload);
var isBigint = (payload) => typeof payload === "bigint";
var isInfinite = (payload) => payload === Infinity || payload === -Infinity;
var isTypedArray = (payload) => ArrayBuffer.isView(payload) && !(payload instanceof DataView);
var isURL = (payload) => payload instanceof URL;

// ../node_modules/superjson/dist/pathstringifier.js
var escapeKey = (key) => key.replace(/\\/g, "\\\\").replace(/\./g, "\\.");
var stringifyPath = (path) => path.map(String).map(escapeKey).join(".");
var parsePath = (string, legacyPaths) => {
  const result = [];
  let segment = "";
  for (let i = 0;i < string.length; i++) {
    let char = string.charAt(i);
    if (!legacyPaths && char === "\\") {
      const escaped = string.charAt(i + 1);
      if (escaped === "\\") {
        segment += "\\";
        i++;
        continue;
      } else if (escaped !== ".") {
        throw Error("invalid path");
      }
    }
    const isEscapedDot = char === "\\" && string.charAt(i + 1) === ".";
    if (isEscapedDot) {
      segment += ".";
      i++;
      continue;
    }
    const isEndOfSegment = char === ".";
    if (isEndOfSegment) {
      result.push(segment);
      segment = "";
      continue;
    }
    segment += char;
  }
  const lastSegment = segment;
  result.push(lastSegment);
  return result;
};

// ../node_modules/superjson/dist/transformer.js
function simpleTransformation(isApplicable, annotation, transform, untransform) {
  return {
    isApplicable,
    annotation,
    transform,
    untransform
  };
}
var simpleRules = [
  simpleTransformation(isUndefined, "undefined", () => null, () => {
    return;
  }),
  simpleTransformation(isBigint, "bigint", (v) => v.toString(), (v) => {
    if (typeof BigInt !== "undefined") {
      return BigInt(v);
    }
    console.error("Please add a BigInt polyfill.");
    return v;
  }),
  simpleTransformation(isDate, "Date", (v) => v.toISOString(), (v) => new Date(v)),
  simpleTransformation(isError, "Error", (v, superJson) => {
    const baseError = {
      name: v.name,
      message: v.message
    };
    if ("cause" in v) {
      baseError.cause = v.cause;
    }
    superJson.allowedErrorProps.forEach((prop) => {
      baseError[prop] = v[prop];
    });
    return baseError;
  }, (v, superJson) => {
    const e = new Error(v.message, { cause: v.cause });
    e.name = v.name;
    e.stack = v.stack;
    superJson.allowedErrorProps.forEach((prop) => {
      e[prop] = v[prop];
    });
    return e;
  }),
  simpleTransformation(isRegExp, "regexp", (v) => "" + v, (regex) => {
    const body = regex.slice(1, regex.lastIndexOf("/"));
    const flags = regex.slice(regex.lastIndexOf("/") + 1);
    return new RegExp(body, flags);
  }),
  simpleTransformation(isSet, "set", (v) => [...v.values()], (v) => new Set(v)),
  simpleTransformation(isMap, "map", (v) => [...v.entries()], (v) => new Map(v)),
  simpleTransformation((v) => isNaNValue(v) || isInfinite(v), "number", (v) => {
    if (isNaNValue(v)) {
      return "NaN";
    }
    if (v > 0) {
      return "Infinity";
    } else {
      return "-Infinity";
    }
  }, Number),
  simpleTransformation((v) => v === 0 && 1 / v === -Infinity, "number", () => {
    return "-0";
  }, Number),
  simpleTransformation(isURL, "URL", (v) => v.toString(), (v) => new URL(v))
];
function compositeTransformation(isApplicable, annotation, transform, untransform) {
  return {
    isApplicable,
    annotation,
    transform,
    untransform
  };
}
var symbolRule = compositeTransformation((s, superJson) => {
  if (isSymbol(s)) {
    const isRegistered = !!superJson.symbolRegistry.getIdentifier(s);
    return isRegistered;
  }
  return false;
}, (s, superJson) => {
  const identifier = superJson.symbolRegistry.getIdentifier(s);
  return ["symbol", identifier];
}, (v) => v.description, (_, a, superJson) => {
  const value = superJson.symbolRegistry.getValue(a[1]);
  if (!value) {
    throw new Error("Trying to deserialize unknown symbol");
  }
  return value;
});
var constructorToName = [
  Int8Array,
  Uint8Array,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  Uint8ClampedArray
].reduce((obj, ctor) => {
  obj[ctor.name] = ctor;
  return obj;
}, {});
var typedArrayRule = compositeTransformation(isTypedArray, (v) => ["typed-array", v.constructor.name], (v) => [...v], (v, a) => {
  const ctor = constructorToName[a[1]];
  if (!ctor) {
    throw new Error("Trying to deserialize unknown typed array");
  }
  return new ctor(v);
});
function isInstanceOfRegisteredClass(potentialClass, superJson) {
  if (potentialClass?.constructor) {
    const isRegistered = !!superJson.classRegistry.getIdentifier(potentialClass.constructor);
    return isRegistered;
  }
  return false;
}
var classRule = compositeTransformation(isInstanceOfRegisteredClass, (clazz, superJson) => {
  const identifier = superJson.classRegistry.getIdentifier(clazz.constructor);
  return ["class", identifier];
}, (clazz, superJson) => {
  const allowedProps = superJson.classRegistry.getAllowedProps(clazz.constructor);
  if (!allowedProps) {
    return { ...clazz };
  }
  const result = {};
  allowedProps.forEach((prop) => {
    result[prop] = clazz[prop];
  });
  return result;
}, (v, a, superJson) => {
  const clazz = superJson.classRegistry.getValue(a[1]);
  if (!clazz) {
    throw new Error(`Trying to deserialize unknown class '${a[1]}' - check https://github.com/blitz-js/superjson/issues/116#issuecomment-773996564`);
  }
  return Object.assign(Object.create(clazz.prototype), v);
});
var customRule = compositeTransformation((value, superJson) => {
  return !!superJson.customTransformerRegistry.findApplicable(value);
}, (value, superJson) => {
  const transformer = superJson.customTransformerRegistry.findApplicable(value);
  return ["custom", transformer.name];
}, (value, superJson) => {
  const transformer = superJson.customTransformerRegistry.findApplicable(value);
  return transformer.serialize(value);
}, (v, a, superJson) => {
  const transformer = superJson.customTransformerRegistry.findByName(a[1]);
  if (!transformer) {
    throw new Error("Trying to deserialize unknown custom value");
  }
  return transformer.deserialize(v);
});
var compositeRules = [classRule, symbolRule, customRule, typedArrayRule];
var transformValue = (value, superJson) => {
  const applicableCompositeRule = findArr(compositeRules, (rule) => rule.isApplicable(value, superJson));
  if (applicableCompositeRule) {
    return {
      value: applicableCompositeRule.transform(value, superJson),
      type: applicableCompositeRule.annotation(value, superJson)
    };
  }
  const applicableSimpleRule = findArr(simpleRules, (rule) => rule.isApplicable(value, superJson));
  if (applicableSimpleRule) {
    return {
      value: applicableSimpleRule.transform(value, superJson),
      type: applicableSimpleRule.annotation
    };
  }
  return;
};
var simpleRulesByAnnotation = {};
simpleRules.forEach((rule) => {
  simpleRulesByAnnotation[rule.annotation] = rule;
});
var untransformValue = (json, type, superJson) => {
  if (isArray(type)) {
    switch (type[0]) {
      case "symbol":
        return symbolRule.untransform(json, type, superJson);
      case "class":
        return classRule.untransform(json, type, superJson);
      case "custom":
        return customRule.untransform(json, type, superJson);
      case "typed-array":
        return typedArrayRule.untransform(json, type, superJson);
      default:
        throw new Error("Unknown transformation: " + type);
    }
  } else {
    const transformation = simpleRulesByAnnotation[type];
    if (!transformation) {
      throw new Error("Unknown transformation: " + type);
    }
    return transformation.untransform(json, superJson);
  }
};

// ../node_modules/superjson/dist/accessDeep.js
var getNthKey = (value, n) => {
  if (n > value.size)
    throw new Error("index out of bounds");
  const keys = value.keys();
  while (n > 0) {
    keys.next();
    n--;
  }
  return keys.next().value;
};
function validatePath(path) {
  if (includes(path, "__proto__")) {
    throw new Error("__proto__ is not allowed as a property");
  }
  if (includes(path, "prototype")) {
    throw new Error("prototype is not allowed as a property");
  }
  if (includes(path, "constructor")) {
    throw new Error("constructor is not allowed as a property");
  }
}
var getDeep = (object, path) => {
  validatePath(path);
  for (let i = 0;i < path.length; i++) {
    const key = path[i];
    if (isSet(object)) {
      object = getNthKey(object, +key);
    } else if (isMap(object)) {
      const row = +key;
      const type = +path[++i] === 0 ? "key" : "value";
      const keyOfRow = getNthKey(object, row);
      switch (type) {
        case "key":
          object = keyOfRow;
          break;
        case "value":
          object = object.get(keyOfRow);
          break;
      }
    } else {
      object = object[key];
    }
  }
  return object;
};
var setDeep = (object, path, mapper) => {
  validatePath(path);
  if (path.length === 0) {
    return mapper(object);
  }
  let parent = object;
  for (let i = 0;i < path.length - 1; i++) {
    const key = path[i];
    if (isArray(parent)) {
      const index = +key;
      parent = parent[index];
    } else if (isPlainObject(parent)) {
      parent = parent[key];
    } else if (isSet(parent)) {
      const row = +key;
      parent = getNthKey(parent, row);
    } else if (isMap(parent)) {
      const isEnd = i === path.length - 2;
      if (isEnd) {
        break;
      }
      const row = +key;
      const type = +path[++i] === 0 ? "key" : "value";
      const keyOfRow = getNthKey(parent, row);
      switch (type) {
        case "key":
          parent = keyOfRow;
          break;
        case "value":
          parent = parent.get(keyOfRow);
          break;
      }
    }
  }
  const lastKey = path[path.length - 1];
  if (isArray(parent)) {
    parent[+lastKey] = mapper(parent[+lastKey]);
  } else if (isPlainObject(parent)) {
    parent[lastKey] = mapper(parent[lastKey]);
  }
  if (isSet(parent)) {
    const oldValue = getNthKey(parent, +lastKey);
    const newValue = mapper(oldValue);
    if (oldValue !== newValue) {
      parent.delete(oldValue);
      parent.add(newValue);
    }
  }
  if (isMap(parent)) {
    const row = +path[path.length - 2];
    const keyToRow = getNthKey(parent, row);
    const type = +lastKey === 0 ? "key" : "value";
    switch (type) {
      case "key": {
        const newKey = mapper(keyToRow);
        parent.set(newKey, parent.get(keyToRow));
        if (newKey !== keyToRow) {
          parent.delete(keyToRow);
        }
        break;
      }
      case "value": {
        parent.set(keyToRow, mapper(parent.get(keyToRow)));
        break;
      }
    }
  }
  return object;
};

// ../node_modules/superjson/dist/plainer.js
var enableLegacyPaths = (version) => version < 1;
function traverse(tree, walker, version, origin = []) {
  if (!tree) {
    return;
  }
  const legacyPaths = enableLegacyPaths(version);
  if (!isArray(tree)) {
    forEach(tree, (subtree, key) => traverse(subtree, walker, version, [
      ...origin,
      ...parsePath(key, legacyPaths)
    ]));
    return;
  }
  const [nodeValue, children] = tree;
  if (children) {
    forEach(children, (child, key) => {
      traverse(child, walker, version, [
        ...origin,
        ...parsePath(key, legacyPaths)
      ]);
    });
  }
  walker(nodeValue, origin);
}
function applyValueAnnotations(plain, annotations, version, superJson) {
  traverse(annotations, (type, path) => {
    plain = setDeep(plain, path, (v) => untransformValue(v, type, superJson));
  }, version);
  return plain;
}
function applyReferentialEqualityAnnotations(plain, annotations, version) {
  const legacyPaths = enableLegacyPaths(version);
  function apply(identicalPaths, path) {
    const object = getDeep(plain, parsePath(path, legacyPaths));
    identicalPaths.map((path2) => parsePath(path2, legacyPaths)).forEach((identicalObjectPath) => {
      plain = setDeep(plain, identicalObjectPath, () => object);
    });
  }
  if (isArray(annotations)) {
    const [root, other] = annotations;
    root.forEach((identicalPath) => {
      plain = setDeep(plain, parsePath(identicalPath, legacyPaths), () => plain);
    });
    if (other) {
      forEach(other, apply);
    }
  } else {
    forEach(annotations, apply);
  }
  return plain;
}
var isDeep = (object, superJson) => isPlainObject(object) || isArray(object) || isMap(object) || isSet(object) || isError(object) || isInstanceOfRegisteredClass(object, superJson);
function addIdentity(object, path, identities) {
  const existingSet = identities.get(object);
  if (existingSet) {
    existingSet.push(path);
  } else {
    identities.set(object, [path]);
  }
}
function generateReferentialEqualityAnnotations(identitites, dedupe) {
  const result = {};
  let rootEqualityPaths = undefined;
  identitites.forEach((paths) => {
    if (paths.length <= 1) {
      return;
    }
    if (!dedupe) {
      paths = paths.map((path) => path.map(String)).sort((a, b) => a.length - b.length);
    }
    const [representativePath, ...identicalPaths] = paths;
    if (representativePath.length === 0) {
      rootEqualityPaths = identicalPaths.map(stringifyPath);
    } else {
      result[stringifyPath(representativePath)] = identicalPaths.map(stringifyPath);
    }
  });
  if (rootEqualityPaths) {
    if (isEmptyObject(result)) {
      return [rootEqualityPaths];
    } else {
      return [rootEqualityPaths, result];
    }
  } else {
    return isEmptyObject(result) ? undefined : result;
  }
}
var walker = (object, identities, superJson, dedupe, path = [], objectsInThisPath = [], seenObjects = new Map) => {
  const primitive = isPrimitive(object);
  if (!primitive) {
    addIdentity(object, path, identities);
    const seen = seenObjects.get(object);
    if (seen) {
      return dedupe ? {
        transformedValue: null
      } : seen;
    }
  }
  if (!isDeep(object, superJson)) {
    const transformed2 = transformValue(object, superJson);
    const result2 = transformed2 ? {
      transformedValue: transformed2.value,
      annotations: [transformed2.type]
    } : {
      transformedValue: object
    };
    if (!primitive) {
      seenObjects.set(object, result2);
    }
    return result2;
  }
  if (includes(objectsInThisPath, object)) {
    return {
      transformedValue: null
    };
  }
  const transformationResult = transformValue(object, superJson);
  const transformed = transformationResult?.value ?? object;
  const transformedValue = isArray(transformed) ? [] : {};
  const innerAnnotations = {};
  forEach(transformed, (value, index) => {
    if (index === "__proto__" || index === "constructor" || index === "prototype") {
      throw new Error(`Detected property ${index}. This is a prototype pollution risk, please remove it from your object.`);
    }
    const recursiveResult = walker(value, identities, superJson, dedupe, [...path, index], [...objectsInThisPath, object], seenObjects);
    transformedValue[index] = recursiveResult.transformedValue;
    if (isArray(recursiveResult.annotations)) {
      innerAnnotations[escapeKey(index)] = recursiveResult.annotations;
    } else if (isPlainObject(recursiveResult.annotations)) {
      forEach(recursiveResult.annotations, (tree, key) => {
        innerAnnotations[escapeKey(index) + "." + key] = tree;
      });
    }
  });
  const result = isEmptyObject(innerAnnotations) ? {
    transformedValue,
    annotations: transformationResult ? [transformationResult.type] : undefined
  } : {
    transformedValue,
    annotations: transformationResult ? [transformationResult.type, innerAnnotations] : innerAnnotations
  };
  if (!primitive) {
    seenObjects.set(object, result);
  }
  return result;
};

// ../node_modules/is-what/dist/getType.js
function getType2(payload) {
  return Object.prototype.toString.call(payload).slice(8, -1);
}

// ../node_modules/is-what/dist/isArray.js
function isArray2(payload) {
  return getType2(payload) === "Array";
}
// ../node_modules/is-what/dist/isPlainObject.js
function isPlainObject2(payload) {
  if (getType2(payload) !== "Object")
    return false;
  const prototype = Object.getPrototypeOf(payload);
  return !!prototype && prototype.constructor === Object && prototype === Object.prototype;
}
// ../node_modules/copy-anything/dist/index.js
function assignProp(carry, key, newVal, originalObject, includeNonenumerable) {
  const propType = {}.propertyIsEnumerable.call(originalObject, key) ? "enumerable" : "nonenumerable";
  if (propType === "enumerable")
    carry[key] = newVal;
  if (includeNonenumerable && propType === "nonenumerable") {
    Object.defineProperty(carry, key, {
      value: newVal,
      enumerable: false,
      writable: true,
      configurable: true
    });
  }
}
function copy(target, options = {}) {
  if (isArray2(target)) {
    return target.map((item) => copy(item, options));
  }
  if (!isPlainObject2(target)) {
    return target;
  }
  const props = Object.getOwnPropertyNames(target);
  const symbols = Object.getOwnPropertySymbols(target);
  return [...props, ...symbols].reduce((carry, key) => {
    if (key === "__proto__")
      return carry;
    if (isArray2(options.props) && !options.props.includes(key)) {
      return carry;
    }
    const val = target[key];
    const newVal = copy(val, options);
    assignProp(carry, key, newVal, target, options.nonenumerable);
    return carry;
  }, {});
}

// ../node_modules/superjson/dist/index.js
class SuperJSON {
  constructor({ dedupe = false } = {}) {
    this.classRegistry = new ClassRegistry;
    this.symbolRegistry = new Registry((s) => s.description ?? "");
    this.customTransformerRegistry = new CustomTransformerRegistry;
    this.allowedErrorProps = [];
    this.dedupe = dedupe;
  }
  serialize(object) {
    const identities = new Map;
    const output = walker(object, identities, this, this.dedupe);
    const res = {
      json: output.transformedValue
    };
    if (output.annotations) {
      res.meta = {
        ...res.meta,
        values: output.annotations
      };
    }
    const equalityAnnotations = generateReferentialEqualityAnnotations(identities, this.dedupe);
    if (equalityAnnotations) {
      res.meta = {
        ...res.meta,
        referentialEqualities: equalityAnnotations
      };
    }
    if (res.meta)
      res.meta.v = 1;
    return res;
  }
  deserialize(payload, options) {
    const { json, meta } = payload;
    let result = options?.inPlace ? json : copy(json);
    if (meta?.values) {
      result = applyValueAnnotations(result, meta.values, meta.v ?? 0, this);
    }
    if (meta?.referentialEqualities) {
      result = applyReferentialEqualityAnnotations(result, meta.referentialEqualities, meta.v ?? 0);
    }
    return result;
  }
  stringify(object) {
    return JSON.stringify(this.serialize(object));
  }
  parse(string) {
    return this.deserialize(JSON.parse(string), { inPlace: true });
  }
  registerClass(v, options) {
    this.classRegistry.register(v, options);
  }
  registerSymbol(v, identifier) {
    this.symbolRegistry.register(v, identifier);
  }
  registerCustom(transformer, name) {
    this.customTransformerRegistry.register({
      name,
      ...transformer
    });
  }
  allowErrorProps(...props) {
    this.allowedErrorProps.push(...props);
  }
}
SuperJSON.defaultInstance = new SuperJSON;
SuperJSON.serialize = SuperJSON.defaultInstance.serialize.bind(SuperJSON.defaultInstance);
SuperJSON.deserialize = SuperJSON.defaultInstance.deserialize.bind(SuperJSON.defaultInstance);
SuperJSON.stringify = SuperJSON.defaultInstance.stringify.bind(SuperJSON.defaultInstance);
SuperJSON.parse = SuperJSON.defaultInstance.parse.bind(SuperJSON.defaultInstance);
SuperJSON.registerClass = SuperJSON.defaultInstance.registerClass.bind(SuperJSON.defaultInstance);
SuperJSON.registerSymbol = SuperJSON.defaultInstance.registerSymbol.bind(SuperJSON.defaultInstance);
SuperJSON.registerCustom = SuperJSON.defaultInstance.registerCustom.bind(SuperJSON.defaultInstance);
SuperJSON.allowErrorProps = SuperJSON.defaultInstance.allowErrorProps.bind(SuperJSON.defaultInstance);
var dist_default = SuperJSON;
var serialize = SuperJSON.serialize;
var deserialize = SuperJSON.deserialize;
var stringify = SuperJSON.stringify;
var parse = SuperJSON.parse;
var registerClass = SuperJSON.registerClass;
var registerCustom = SuperJSON.registerCustom;
var registerSymbol = SuperJSON.registerSymbol;
var allowErrorProps = SuperJSON.allowErrorProps;

// src/client.ts
var DEFAULT_API_URL = "http://localhost:3000";
function getGlobalOptions(command) {
  return command.optsWithGlobals();
}
function resolveApiUrl(command) {
  const options = getGlobalOptions(command);
  return options.url ?? process.env.ADSOLUTE_API_URL ?? DEFAULT_API_URL;
}
function createApiClient(baseUrl) {
  return createTRPCClient({
    links: [
      httpBatchLink({
        url: `${baseUrl.replace(/\/$/, "")}/api/trpc`,
        transformer: dist_default
      })
    ]
  });
}

// src/output.ts
var import_cli_table3 = __toESM(require_table(), 1);
function formatCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}
function printTable(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      console.log("[]");
      return;
    }
    const rows = value.filter((row) => Boolean(row) && typeof row === "object" && !Array.isArray(row));
    if (rows.length !== value.length) {
      console.log(JSON.stringify(value, null, 2));
      return;
    }
    const head = Array.from(rows.reduce((keys, row) => {
      for (const key of Object.keys(row)) {
        keys.add(key);
      }
      return keys;
    }, new Set));
    const table = new import_cli_table3.default({ head });
    for (const row of rows) {
      table.push(head.map((key) => formatCell(row[key])));
    }
    console.log(table.toString());
    return;
  }
  if (value && typeof value === "object") {
    const table = new import_cli_table3.default({
      head: ["Field", "Value"],
      colWidths: [24, 80],
      wordWrap: true
    });
    for (const [key, cellValue] of Object.entries(value)) {
      table.push([key, formatCell(cellValue)]);
    }
    console.log(table.toString());
    return;
  }
  console.log(formatCell(value));
}
function printOutput(value, asTable) {
  if (asTable) {
    printTable(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

// src/utils.ts
function parseList(value) {
  if (!value) {
    return;
  }
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}
function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined));
}
async function readCsvRows(filePath, integerFields = []) {
  const content = await readFile(resolve(filePath), "utf8");
  const parsed = import_papaparse.default.parse(content, {
    header: true,
    skipEmptyLines: true
  });
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join("; "));
  }
  return parsed.data.map((row) => {
    const normalized = {};
    for (const [key, rawValue] of Object.entries(row)) {
      if (!key) {
        continue;
      }
      const value = typeof rawValue === "string" ? rawValue.trim() : rawValue;
      if (value === "" || value === undefined) {
        continue;
      }
      if (integerFields.includes(key)) {
        const parsedInteger = Number.parseInt(value, 10);
        normalized[key] = Number.isNaN(parsedInteger) ? value : parsedInteger;
        continue;
      }
      normalized[key] = value;
    }
    return normalized;
  });
}
async function runCommand(command, action) {
  try {
    const client = createApiClient(resolveApiUrl(command));
    const result = await action(client);
    if (result !== undefined) {
      printOutput(result, Boolean(getGlobalOptions(command).table));
    }
  } catch (error) {
    if (error instanceof TRPCClientError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

// src/commands/accounts.ts
function registerAccountsCommands(program2) {
  const accounts = program2.command("accounts").description("Manage accounts");
  accounts.command("list").action(async (command) => {
    await runCommand(command, (client) => client.account.list.query());
  });
  accounts.command("get <id>").action(async (id, command) => {
    await runCommand(command, (client) => client.account.getById.query({ id }));
  });
  accounts.command("create").requiredOption("--name <name>").requiredOption("--meta-account-id <metaAccountId>").option("--meta-access-token <metaAccessToken>").option("--notes <notes>").action(async (options, command) => {
    await runCommand(command, (client) => client.account.create.mutate({
      name: options.name,
      metaAccountId: options.metaAccountId,
      metaAccessToken: options.metaAccessToken,
      notes: options.notes
    }));
  });
  accounts.command("update <id>").option("--name <name>").option("--meta-account-id <metaAccountId>").option("--meta-access-token <metaAccessToken>").option("--notes <notes>").action(async (id, options, command) => {
    await runCommand(command, (client) => client.account.update.mutate({
      id,
      ...compactObject({
        name: options.name,
        metaAccountId: options.metaAccountId,
        metaAccessToken: options.metaAccessToken,
        notes: options.notes
      })
    }));
  });
  accounts.command("delete <id>").action(async (id, command) => {
    await runCommand(command, async (client) => {
      await client.account.delete.mutate({ id });
      return { deleted: true, id };
    });
  });
}

// src/commands/ads.ts
var AD_IMPORT_INTEGER_FIELDS = ["conversions", "impressions", "reach"];
function registerAdCommands(program2) {
  const ads = program2.command("ads").description("Manage ads");
  ads.command("list").action(async (command) => {
    await runCommand(command, (client) => client.ad.list.query());
  });
  ads.command("get <id>").action(async (id, command) => {
    await runCommand(command, (client) => client.ad.getById.query({ id }));
  });
  ads.command("by-set <adSetId>").action(async (adSetId, command) => {
    await runCommand(command, (client) => client.ad.listByAdSet.query({ adSetId }));
  });
  ads.command("by-creative <adCreativeId>").action(async (adCreativeId, command) => {
    await runCommand(command, (client) => client.ad.listByCreative.query({ adCreativeId }));
  });
  ads.command("create").requiredOption("--ad-set-id <adSetId>").option("--name <name>").option("--creative-id <adCreativeId>").option("--landing-page-version-id <landingPageVersionId>").option("--meta-id <metaId>").action(async (options, command) => {
    await runCommand(command, (client) => client.ad.create.mutate(compactObject({
      adSetId: options.adSetId,
      name: options.name,
      adCreativeId: options.creativeId,
      landingPageVersionId: options.landingPageVersionId,
      metaId: options.metaId
    })));
  });
  ads.command("update <id>").option("--name <name>").option("--ad-set-id <adSetId>").option("--creative-id <adCreativeId>").option("--landing-page-version-id <landingPageVersionId>").option("--status <status>").option("--meta-id <metaId>").option("--notes <notes>").action(async (id, options, command) => {
    await runCommand(command, (client) => client.ad.update.mutate({
      id,
      ...compactObject({
        name: options.name,
        adSetId: options.adSetId,
        adCreativeId: options.creativeId,
        landingPageVersionId: options.landingPageVersionId,
        status: options.status,
        metaId: options.metaId,
        notes: options.notes
      })
    }));
  });
  ads.command("delete <id>").action(async (id, command) => {
    await runCommand(command, async (client) => {
      await client.ad.delete.mutate({ id });
      return { deleted: true, id };
    });
  });
  ads.command("import").requiredOption("--ad-set-id <adSetId>").requiredOption("--file <file>").action(async (options, command) => {
    await runCommand(command, async (client) => {
      const rows = await readCsvRows(options.file, AD_IMPORT_INTEGER_FIELDS);
      return client.ad.bulkImport.mutate({
        adSetId: options.adSetId,
        rows: rows.map((row) => ({
          name: String(row.name),
          roas: row.roas !== undefined ? String(row.roas) : undefined,
          cpa: row.cpa !== undefined ? String(row.cpa) : undefined,
          ctr: row.ctr !== undefined ? String(row.ctr) : undefined,
          conversionRate: row.conversionRate !== undefined ? String(row.conversionRate) : undefined,
          spend: row.spend !== undefined ? String(row.spend) : undefined,
          conversions: typeof row.conversions === "number" ? row.conversions : undefined,
          impressions: typeof row.impressions === "number" ? row.impressions : undefined,
          reach: typeof row.reach === "number" ? row.reach : undefined,
          frequency: row.frequency !== undefined ? String(row.frequency) : undefined,
          cpm: row.cpm !== undefined ? String(row.cpm) : undefined,
          qualityRanking: row.qualityRanking !== undefined ? String(row.qualityRanking) : undefined,
          engagementRateRanking: row.engagementRateRanking !== undefined ? String(row.engagementRateRanking) : undefined,
          conversionRateRanking: row.conversionRateRanking !== undefined ? String(row.conversionRateRanking) : undefined,
          dateStart: row.dateStart !== undefined ? String(row.dateStart) : undefined,
          dateEnd: row.dateEnd !== undefined ? String(row.dateEnd) : undefined
        }))
      });
    });
  });
}

// src/commands/ad-sets.ts
function registerAdSetCommands(program2) {
  const adSets = program2.command("ad-sets").description("Manage ad sets");
  adSets.command("list").action(async (command) => {
    await runCommand(command, (client) => client.adSet.list.query());
  });
  adSets.command("get <id>").action(async (id, command) => {
    await runCommand(command, (client) => client.adSet.getById.query({ id }));
  });
  adSets.command("create").requiredOption("--campaign-id <campaignId>").option("--name <name>").option("--meta-id <metaId>").option("--cost-cap <costCap>").option("--daily-budget <dailyBudget>").option("--targeting-method <targetingMethod>").option("--geos <geos>").option("--placements <placements>").option("--demographics <demographics>").option("--schedule-start <scheduleStart>").option("--schedule-end <scheduleEnd>").action(async (options, command) => {
    await runCommand(command, (client) => client.adSet.create.mutate({
      campaignId: options.campaignId,
      ...compactObject({
        name: options.name,
        metaId: options.metaId,
        costCap: options.costCap,
        dailyBudget: options.dailyBudget,
        targetingMethod: parseList(options.targetingMethod),
        geos: parseList(options.geos),
        placements: parseList(options.placements),
        demographics: options.demographics,
        scheduleStart: options.scheduleStart,
        scheduleEnd: options.scheduleEnd
      })
    }));
  });
  adSets.command("update <id>").option("--campaign-id <campaignId>").option("--name <name>").option("--meta-id <metaId>").option("--cost-cap <costCap>").option("--daily-budget <dailyBudget>").option("--targeting-method <targetingMethod>").option("--geos <geos>").option("--placements <placements>").option("--demographics <demographics>").option("--schedule-start <scheduleStart>").option("--schedule-end <scheduleEnd>").option("--status <status>").option("--notes <notes>").action(async (id, options, command) => {
    await runCommand(command, (client) => client.adSet.update.mutate({
      id,
      ...compactObject({
        campaignId: options.campaignId,
        name: options.name,
        metaId: options.metaId,
        costCap: options.costCap,
        dailyBudget: options.dailyBudget,
        targetingMethod: parseList(options.targetingMethod),
        geos: parseList(options.geos),
        placements: parseList(options.placements),
        demographics: options.demographics,
        scheduleStart: options.scheduleStart,
        scheduleEnd: options.scheduleEnd,
        status: options.status,
        notes: options.notes
      })
    }));
  });
  adSets.command("delete <id>").action(async (id, command) => {
    await runCommand(command, async (client) => {
      await client.adSet.delete.mutate({ id });
      return { deleted: true, id };
    });
  });
  adSets.command("import").requiredOption("--campaign-id <campaignId>").requiredOption("--file <file>").action(async (options, command) => {
    await runCommand(command, async (client) => {
      const rows = await readCsvRows(options.file);
      return client.adSet.bulkImport.mutate({
        campaignId: options.campaignId,
        rows: rows.map((row) => ({
          name: String(row.name),
          dailyBudget: row.dailyBudget !== undefined ? String(row.dailyBudget) : undefined,
          costCap: row.costCap !== undefined ? String(row.costCap) : undefined
        }))
      });
    });
  });
}

// src/commands/campaigns.ts
function registerCampaignCommands(program2) {
  const campaigns = program2.command("campaigns").description("Manage campaigns");
  campaigns.command("list").action(async (command) => {
    await runCommand(command, (client) => client.campaign.list.query());
  });
  campaigns.command("get <id>").action(async (id, command) => {
    await runCommand(command, (client) => client.campaign.getById.query({ id }));
  });
  campaigns.command("create").option("--name <name>").option("--meta-id <metaId>").action(async (options, command) => {
    await runCommand(command, (client) => client.campaign.create.mutate(compactObject({
      name: options.name,
      metaId: options.metaId
    })));
  });
  campaigns.command("update <id>").option("--name <name>").option("--objective <objective>").option("--status <status>").option("--meta-id <metaId>").option("--notes <notes>").action(async (id, options, command) => {
    await runCommand(command, (client) => client.campaign.update.mutate({
      id,
      ...compactObject({
        name: options.name,
        objective: options.objective,
        status: options.status,
        metaId: options.metaId,
        notes: options.notes
      })
    }));
  });
  campaigns.command("delete <id>").action(async (id, command) => {
    await runCommand(command, async (client) => {
      await client.campaign.delete.mutate({ id });
      return { deleted: true, id };
    });
  });
  campaigns.command("import").requiredOption("--file <file>").action(async (options, command) => {
    await runCommand(command, async (client) => {
      const rows = await readCsvRows(options.file);
      return client.campaign.bulkImport.mutate({
        rows: rows.map((row) => ({ name: String(row.name) }))
      });
    });
  });
}

// src/commands/creatives.ts
var CREATIVE_IMPORT_INTEGER_FIELDS = [
  "conversions",
  "impressions",
  "reach",
  "linkClicks",
  "clicksAll",
  "landingPageViews",
  "addToCart",
  "initiateCheckout",
  "videoViews3s",
  "videoThruplay"
];
function registerCreativeCommands(program2) {
  const creatives = program2.command("creatives").description("Manage ad creatives");
  creatives.command("list").option("--format <format>").option("--awareness-level <awarenessLevel>").option("--search <search>").option("--account-id <accountId>").option("--untagged-only", "Show only untagged creatives").action(async (options, command) => {
    await runCommand(command, (client) => client.adCreative.list.query(compactObject({
      format: options.format,
      awarenessLevel: options.awarenessLevel,
      search: options.search,
      accountId: options.accountId,
      untaggedOnly: options.untaggedOnly || undefined
    })));
  });
  creatives.command("get <id>").action(async (id, command) => {
    await runCommand(command, (client) => client.adCreative.getById.query({ id }));
  });
  creatives.command("performance <id>").action(async (id, command) => {
    await runCommand(command, (client) => client.adCreative.getPerformance.query({ id }));
  });
  creatives.command("create").option("--name <name>").action(async (options, command) => {
    await runCommand(command, (client) => client.adCreative.create.mutate(compactObject({
      name: options.name
    })));
  });
  creatives.command("update <id>").option("--name <name>").option("--asset-url <assetUrl>").option("--format <format>").option("--angle <angle>").option("--persona <persona>").option("--awareness-level <awarenessLevel>").option("--hook <hook>").option("--tone <tone>").option("--cta <cta>").option("--landing-page-id <landingPageId>").option("--notes <notes>").action(async (id, options, command) => {
    await runCommand(command, (client) => client.adCreative.update.mutate({
      id,
      ...compactObject({
        name: options.name,
        assetUrl: options.assetUrl,
        format: options.format,
        angle: options.angle,
        persona: options.persona,
        awarenessLevel: options.awarenessLevel,
        hook: options.hook,
        tone: parseList(options.tone),
        cta: options.cta,
        landingPageId: options.landingPageId,
        notes: options.notes
      })
    }));
  });
  creatives.command("delete <id>").action(async (id, command) => {
    await runCommand(command, async (client) => {
      await client.adCreative.delete.mutate({ id });
      return { deleted: true, id };
    });
  });
  creatives.command("duplicate <id>").action(async (id, command) => {
    await runCommand(command, (client) => client.adCreative.duplicate.mutate({ id }));
  });
  creatives.command("bulk-import").requiredOption("--file <file>").option("--account-id <accountId>").action(async (options, command) => {
    await runCommand(command, async (client) => {
      const rows = await readCsvRows(options.file, CREATIVE_IMPORT_INTEGER_FIELDS);
      return client.adCreative.bulkImport.mutate({
        accountId: options.accountId,
        rows: rows.map((row) => ({
          name: String(row.name),
          roas: row.roas !== undefined ? String(row.roas) : undefined,
          cpa: row.cpa !== undefined ? String(row.cpa) : undefined,
          ctr: row.ctr !== undefined ? String(row.ctr) : undefined,
          conversionRate: row.conversionRate !== undefined ? String(row.conversionRate) : undefined,
          spend: row.spend !== undefined ? String(row.spend) : undefined,
          conversions: typeof row.conversions === "number" ? row.conversions : undefined,
          impressions: typeof row.impressions === "number" ? row.impressions : undefined,
          reach: typeof row.reach === "number" ? row.reach : undefined,
          frequency: row.frequency !== undefined ? String(row.frequency) : undefined,
          cpm: row.cpm !== undefined ? String(row.cpm) : undefined,
          qualityRanking: row.qualityRanking !== undefined ? String(row.qualityRanking) : undefined,
          engagementRateRanking: row.engagementRateRanking !== undefined ? String(row.engagementRateRanking) : undefined,
          conversionRateRanking: row.conversionRateRanking !== undefined ? String(row.conversionRateRanking) : undefined,
          linkClicks: typeof row.linkClicks === "number" ? row.linkClicks : undefined,
          clicksAll: typeof row.clicksAll === "number" ? row.clicksAll : undefined,
          cpc: row.cpc !== undefined ? String(row.cpc) : undefined,
          ctrLinkClick: row.ctrLinkClick !== undefined ? String(row.ctrLinkClick) : undefined,
          landingPageViews: typeof row.landingPageViews === "number" ? row.landingPageViews : undefined,
          costPerLpv: row.costPerLpv !== undefined ? String(row.costPerLpv) : undefined,
          purchaseValue: row.purchaseValue !== undefined ? String(row.purchaseValue) : undefined,
          addToCart: typeof row.addToCart === "number" ? row.addToCart : undefined,
          initiateCheckout: typeof row.initiateCheckout === "number" ? row.initiateCheckout : undefined,
          costPerAddToCart: row.costPerAddToCart !== undefined ? String(row.costPerAddToCart) : undefined,
          videoViews3s: typeof row.videoViews3s === "number" ? row.videoViews3s : undefined,
          videoThruplay: typeof row.videoThruplay === "number" ? row.videoThruplay : undefined,
          videoAvgWatchTime: row.videoAvgWatchTime !== undefined ? String(row.videoAvgWatchTime) : undefined,
          country: row.country !== undefined ? String(row.country) : undefined,
          platform: row.platform !== undefined ? String(row.platform) : undefined,
          placement: row.placement !== undefined ? String(row.placement) : undefined,
          device: row.device !== undefined ? String(row.device) : undefined,
          age: row.age !== undefined ? String(row.age) : undefined,
          gender: row.gender !== undefined ? String(row.gender) : undefined,
          delivery: row.delivery !== undefined ? String(row.delivery) : undefined,
          adId: row.adId !== undefined ? String(row.adId) : undefined,
          campaignName: row.campaignName !== undefined ? String(row.campaignName) : undefined,
          campaignId: row.campaignId !== undefined ? String(row.campaignId) : undefined,
          adSetName: row.adSetName !== undefined ? String(row.adSetName) : undefined,
          adSetId: row.adSetId !== undefined ? String(row.adSetId) : undefined,
          dateStart: String(row.dateStart),
          dateEnd: String(row.dateEnd)
        }))
      });
    });
  });
}

// src/commands/landing-pages.ts
function registerLandingPageCommands(program2) {
  const landingPages = program2.command("landing-pages").description("Manage landing pages and versions");
  landingPages.command("list").action(async (command) => {
    await runCommand(command, (client) => client.landingPage.list.query());
  });
  landingPages.command("get <id>").action(async (id, command) => {
    await runCommand(command, (client) => client.landingPage.getById.query({ id }));
  });
  landingPages.command("create").option("--name <name>").option("--url <url>").action(async (options, command) => {
    await runCommand(command, (client) => client.landingPage.create.mutate(compactObject({
      name: options.name,
      url: options.url
    })));
  });
  landingPages.command("update <id>").option("--name <name>").option("--url <url>").action(async (id, options, command) => {
    await runCommand(command, (client) => client.landingPage.update.mutate({
      id,
      ...compactObject({
        name: options.name,
        url: options.url
      })
    }));
  });
  landingPages.command("delete <id>").action(async (id, command) => {
    await runCommand(command, async (client) => {
      await client.landingPage.delete.mutate({ id });
      return { deleted: true, id };
    });
  });
  landingPages.command("duplicate <id>").action(async (id, command) => {
    await runCommand(command, (client) => client.landingPage.duplicate.mutate({ id }));
  });
  landingPages.command("versions <landingPageId>").action(async (landingPageId, command) => {
    await runCommand(command, (client) => client.landingPage.listVersions.query({ landingPageId }));
  });
  landingPages.command("add-version <landingPageId>").requiredOption("--page-type <pageType>").requiredOption("--hero-copy <heroCopy>").requiredOption("--benefits <benefits>").requiredOption("--social-proof-type <socialProofType>").requiredOption("--funnel-position <funnelPosition>").option("--url <url>").option("--screenshot-url <screenshotUrl>").option("--notes <notes>").action(async (landingPageId, options, command) => {
    await runCommand(command, (client) => client.landingPage.createVersion.mutate({
      landingPageId,
      pageType: options.pageType,
      heroCopy: options.heroCopy,
      benefits: parseList(options.benefits) ?? [],
      socialProofType: parseList(options.socialProofType) ?? [],
      funnelPosition: options.funnelPosition,
      url: options.url,
      screenshotUrl: options.screenshotUrl,
      notes: options.notes
    }));
  });
  landingPages.command("update-version <id>").option("--page-type <pageType>").option("--hero-copy <heroCopy>").option("--benefits <benefits>").option("--social-proof-type <socialProofType>").option("--funnel-position <funnelPosition>").option("--url <url>").option("--screenshot-url <screenshotUrl>").option("--notes <notes>").action(async (id, options, command) => {
    await runCommand(command, (client) => client.landingPage.updateVersion.mutate({
      id,
      ...compactObject({
        pageType: options.pageType,
        heroCopy: options.heroCopy,
        benefits: options.benefits ? parseList(options.benefits) ?? [] : undefined,
        socialProofType: options.socialProofType ? parseList(options.socialProofType) ?? [] : undefined,
        funnelPosition: options.funnelPosition,
        url: options.url,
        screenshotUrl: options.screenshotUrl,
        notes: options.notes
      })
    }));
  });
  landingPages.command("delete-version <id>").action(async (id, command) => {
    await runCommand(command, async (client) => {
      await client.landingPage.deleteVersion.mutate({ id });
      return { deleted: true, id };
    });
  });
  landingPages.command("duplicate-version <id>").action(async (id, command) => {
    await runCommand(command, (client) => client.landingPage.duplicateVersion.mutate({ id }));
  });
}

// src/commands/tags.ts
function registerTagCommands(program2) {
  const tags = program2.command("tags").description("Manage entity tags");
  tags.command("search [query]").action(async (query, command) => {
    await runCommand(command, (client) => client.tag.search.query(query ? { query } : undefined));
  });
  tags.command("list").requiredOption("--entity-type <entityType>").requiredOption("--entity-id <entityId>").action(async (options, command) => {
    await runCommand(command, (client) => client.tag.listForEntity.query({
      entityType: options.entityType,
      entityId: options.entityId
    }));
  });
  tags.command("attach").requiredOption("--entity-type <entityType>").requiredOption("--entity-id <entityId>").requiredOption("--tag-name <tagName>").option("--tag-color <tagColor>").action(async (options, command) => {
    await runCommand(command, (client) => client.tag.attach.mutate({
      entityType: options.entityType,
      entityId: options.entityId,
      tagName: options.tagName,
      tagColor: options.tagColor
    }));
  });
  tags.command("detach").requiredOption("--entity-type <entityType>").requiredOption("--entity-id <entityId>").requiredOption("--tag-id <tagId>").action(async (options, command) => {
    await runCommand(command, async (client) => {
      await client.tag.detach.mutate({
        entityType: options.entityType,
        entityId: options.entityId,
        tagId: options.tagId
      });
      return {
        detached: true,
        entityType: options.entityType,
        entityId: options.entityId,
        tagId: options.tagId
      };
    });
  });
}

// src/index.ts
async function main() {
  const program2 = new Command;
  program2.name("adsolute").description("Typed CLI for the Adsolute tRPC API").option("--url <url>", "API base URL, defaults to ADSOLUTE_API_URL or http://localhost:3000").option("--table", "Render output in a table when possible").showHelpAfterError();
  registerAccountsCommands(program2);
  registerCampaignCommands(program2);
  registerAdSetCommands(program2);
  registerAdCommands(program2);
  registerCreativeCommands(program2);
  registerLandingPageCommands(program2);
  registerTagCommands(program2);
  await program2.parseAsync(process.argv);
}
await main();
