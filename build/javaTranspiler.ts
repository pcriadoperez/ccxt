import Transpiler from "ast-transpiler";
import ts from "typescript";
import path from 'path'
import errors from "../js/src/base/errors.js"
import { basename, join, resolve } from 'path'
import { createFolderRecursively, replaceInFile, overwriteFile, writeFile, checkCreateFolder } from './fsLocal.js'
import { platform } from 'process'
import fs from 'fs'
import log from 'ololog'
import ansi from 'ansicolor'
import {Transpiler as OldTranspiler, parallelizeTranspiling } from "./transpile.js";
import { promisify } from 'util';
import errorHierarchy from '../js/src/base/errorHierarchy.js'
import Piscina from 'piscina';
import { isMainEntry } from "./transpile.js";
import { unCamelCase } from "../js/src/base/functions.js";

ansi.nice

type dict = { [key: string]: string }

const promisedWriteFile = promisify (fs.writeFile);

let exchanges = JSON.parse (fs.readFileSync("./exchanges.json", "utf8"));
const exchangeIds: string[] = exchanges.ids

// @ts-expect-error
const metaUrl = import.meta.url
let __dirname = new URL('.', metaUrl).pathname;

let shouldTranspileTests = true

function overwriteFileAndFolder (path: string, content: string) {
    if (!(fs.existsSync(path))) {
        checkCreateFolder (path);
    }
    overwriteFile (path, content);
    writeFile (path, content);
}

// this is necessary because for some reason
// pathname keeps the first '/' for windows paths
// making them invalid
// example: /C:Users/user/Desktop/
if (platform === 'win32') {
    if (__dirname[0] === '/') {
        __dirname = __dirname.substring(1)
    }
}

const GLOBAL_WRAPPER_FILE = './cs/ccxt/base/Exchange.Wrappers.cs';
const EXCHANGE_WRAPPER_FOLDER = './cs/ccxt/wrappers/'
const EXCHANGE_WS_WRAPPER_FOLDER = './cs/ccxt/exchanges/pro/wrappers/'
const ERRORS_FOLDER = './java/lib/src/main/java/io/github/ccxt/errors/';
const BASE_METHODS_FILE = './java/lib/src/main/java/io/github/ccxt/Exchange.java';
const EXCHANGES_FOLDER = './java/lib/src/main/java/io/github/ccxt/exchanges/';
const EXCHANGES_WS_FOLDER = './java/lib/src/main/java/io/github/ccxt/exchanges/pro/';
const GENERATED_TESTS_FOLDER = './java/tests/src/main/java/tests/exchange/';
const BASE_TESTS_FOLDER = 'java/tests/src/main/java/tests/base/';
const BASE_TESTS_FILE =  './java/tests/src/main/java/tests/exchange/TestMain.java';
const EXCHANGE_BASE_FOLDER = './java/tests/src/main/java/tests/exchange/';
const EXCHANGE_GENERATED_FOLDER = './java/tests/src/main/java/tests/exchange/';
const EXAMPLES_INPUT_FOLDER = './examples/ts/';
const EXAMPLES_OUTPUT_FOLDER = './examples/java/examples/';
const csharpComments: any = {};

class NewTranspiler {

    transpiler!: Transpiler;
    pythonStandardLibraries;
    oldTranspiler = new OldTranspiler();

    constructor() {

        this.setupTranspiler()
        // this.transpiler.csharpTranspiler.VAR_TOKEN = 'var'; // tmp fix


        this.pythonStandardLibraries = {
            'hashlib': 'hashlib',
            'math': 'math',
            'json.loads': 'json',
            'json.dumps': 'json',
            'sys': 'sys',
        }
    }

    getWsRegexes() {
        // C# WS regexes — kept for reference but not used for Java
        return [];
    }

    getJavaWsRegexes() {
        // Java-specific WS regexes — converts transpiled code for WS exchange classes
        return [
            // Dynamic exception construction: new getValue(x, key)(msg) → this.newException(getValue(x, key), msg)
            [/new\sHelpers\.GetValue\((\w+),\s*(\w+)\)\((\w+)\)/gm, 'this.newException(Helpers.GetValue($1, $2), $3)'],

            // Client type casts — transpiled code uses Object client, need to cast to Client
            [/\(Object client,/gm, '(Client client,'],
            [/\(Object client\)/gm, '(Client client)'],
            [/Object client =/gm, 'Client client ='],
            [/Object future =/gm, 'Object future ='],

            // client.subscriptions / client.futures — these are Object type fields
            // transpiled code tries to cast them to Map, which works since they're ConcurrentHashMaps
            [/\(java\.util\.Map<String, Object>\)client\.futures/gm, '(java.util.Map)client.futures'],
            [/\(java\.util\.Map<String, Object>\)client\.subscriptions/gm, '(java.util.Map)client.subscriptions'],
            [/\(java\.util\.Map<String, Object>\)this\.clients/gm, '(java.util.Map)this.clients'],

            // new XyzRest() → new Xyz() for instantiating REST parent
            [/new (\w+)Rest\(\)/g, 'new io.github.ccxt.exchanges.$1()'],

            // OrderBook/OrderBookSide operations — these are already our Java types
            // .storeArray, .store, .limit, .reset, .cache — these work directly on our ws types

            // spawn — leave as-is, Exchange.spawn accepts method name + args via reflection
            // The spawn calls will be handled by a Java-side overload

            // ArrayCache constructor — needs FQN for inner classes + int cast
            [/new ArrayCache\((\w+)\)/gm, 'new ArrayCache(((Number)$1).intValue())'],
            [/new ArrayCacheByTimestamp\((\w+)\)/gm, 'new ArrayCache.ArrayCacheByTimestamp(((Number)$1).intValue())'],
            [/new ArrayCacheByTimestamp\(\)/gm, 'new ArrayCache.ArrayCacheByTimestamp()'],
            [/new ArrayCacheBySymbolById\((\w+)\)/gm, 'new ArrayCache.ArrayCacheBySymbolById(((Number)$1).intValue())'],
            [/new ArrayCacheBySymbolById\(\)/gm, 'new ArrayCache.ArrayCacheBySymbolById()'],
            [/new ArrayCacheBySymbolBySide\((\w+)\)/gm, 'new ArrayCache.ArrayCacheBySymbolBySide(((Number)$1).intValue())'],
            [/new ArrayCacheBySymbolBySide\(\)/gm, 'new ArrayCache.ArrayCacheBySymbolBySide()'],
        ]
    }


    // c# custom method
    customCSharpPropAssignment(node: any, identation: any) {
        const stringValue = node.getFullText().trim();
        if (Object.keys(errors).includes(stringValue)) {
            return `typeof(${stringValue})`;
        }
        return undefined;
    }

    // a helper to apply an array of regexes and substitutions to text
    // accepts an array like [ [ regex, substitution ], ... ]

    regexAll (text: string, array: any[]) {
        for (const i in array) {
            let regex = array[i][0]
            const flags = (typeof regex === 'string') ? 'g' : undefined
            regex = new RegExp (regex, flags)
            text = text.replace (regex, array[i][1])
        }
        return text
    }

    // ============================================================================

    iden(level = 1) {
        return '    '.repeat(level)
    }
    // ============================================================================

    getTranspilerConfig() {
        return {
            "verbose": false,
            "csharp": {
                "parser": {
                    "ELEMENT_ACCESS_WRAPPER_OPEN": "getValue(",
                    "ELEMENT_ACCESS_WRAPPER_CLOSE": ")",
                    // "VAR_TOKEN": "var",
                }
            },
        }
    }

    createSee(link: string) {
        return `/// See <see href="${link}"/>  <br/>`
    }

    createParam(param: any) {
        return`/// <item>
    /// <term>${param.name}</term>
    /// <description>
    /// ${param.type} : ${param.description}
    /// </description>
    /// </item>`
    }

    createCsharpCommentTemplate(name: string, desc: string, see: string[], params : string[], returnType:string, returnDesc: string) {
        //
        // Summary:
        //     Converts the value of the specified 16-bit signed integer to an equivalent 64-bit
        //     signed integer.
        //
        // Parameters:
        //   value:
        //     The 16-bit signed integer to convert.
        //
        // Returns:
        //     A 64-bit signed integer that is equivalent to value
        const comment = `
    /// <summary>
    /// ${desc}
    /// </summary>
    /// <remarks>
    ${see.map( l => this.createSee(l)).join("\n    ")}
    /// <list type="table">
    ${params.map( p => this.createParam(p)).join("\n    ")}
    /// </list>
    /// </remarks>
    /// <returns> <term>${returnType}</term> ${returnDesc}.</returns>`
    const commentWithoutEmptyLines = comment.replace(/^\s*[\r\n]/gm, "");
    return commentWithoutEmptyLines;
    }

    transformTSCommentIntoCSharp(name: string, desc: string, sees: string[], params : string[], returnType:string, returnDesc: string) {
        return this.createCsharpCommentTemplate(name, desc, sees, params, returnType, returnDesc);
    }

    transformLeadingComment(comment: any) {
        // parse comment
        // /**
        //  * @method
        //  * @name binance#fetchTime
        //  * @description fetches the current integer timestamp in milliseconds from the exchange server
        //  * @see https://binance-docs.github.io/apidocs/spot/en/#check-server-time       // spot
        //  * @see https://binance-docs.github.io/apidocs/futures/en/#check-server-time    // swap
        //  * @see https://binance-docs.github.io/apidocs/delivery/en/#check-server-time   // future
        //  * @param {object} [params] extra parameters specific to the exchange API endpoint
        //  * @returns {int} the current integer timestamp in milliseconds from the exchange server
        //  */
        // return comment;
        const commentNameRegex = /@name\s(\w+)#(\w+)/;
        const nameMatches = comment.match(commentNameRegex);
        const exchangeName = nameMatches ? nameMatches[1] : undefined;
        if (!exchangeName) {
            return comment;
        }
        const methodName = nameMatches[2];
        const commentDescriptionRegex = /@description\s(.+)/;
        const descriptionMatches = comment.match(commentDescriptionRegex);
        const description = descriptionMatches ? descriptionMatches[1] : undefined;
        const seeRegex = /@see\s(.+)/g;
        const seeMatches = comment.match(seeRegex);
        const sees: string[] = [];
        if (seeMatches) {
            seeMatches.forEach((match: any) => {
                const [, link] = match.split(' ');
                sees.push(link);
            });
        }
        // const paramRegex = /@param\s{(\w+)}\s\[(\w+)\]\s(.+)/g; // @param\s{(\w+)}\s\[((\w+(.\w+)?))\]\s(.+)
        const paramRegex = /@param\s{(\w+[?]?)}\s\[(\w+\.?\w+?)]\s(.+)/g;
        const params = [] as any;
        let paramMatch;
        while ((paramMatch = paramRegex.exec(comment)) !== null) {
            const [, type, name, description] = paramMatch;
            params.push({type, name, description});
        }
        const returnRegex = /@returns\s{(\w+\[?\]?\[?\]?)}\s(.+)/;
        const returnMatch = comment.match(returnRegex);
        const returnType = returnMatch ? returnMatch[1] : undefined;
        const returnDescription =  returnMatch && returnMatch.length > 1 ? returnMatch[2]: undefined;
        let exchangeData = csharpComments[exchangeName];
        if (!exchangeData) {
            exchangeData = csharpComments[exchangeName] = {}
        }
        let exchangeMethods = csharpComments[exchangeName];
        if (!exchangeMethods) {
            exchangeMethods = {}
        }
        const transformedComment = this.transformTSCommentIntoCSharp(methodName, description, sees,params, returnType, returnDescription);
        exchangeMethods[methodName] = transformedComment;
        csharpComments[exchangeName] = exchangeMethods
        return comment;
    }

    setupTranspiler() {
        this.transpiler = new Transpiler (this.getTranspilerConfig())
        this.transpiler.setVerboseMode(false);
        this.transpiler.csharpTranspiler.transformLeadingComment = this.transformLeadingComment.bind(this);
    }

    createGeneratedHeader() {
        return [
            "// PLEASE DO NOT EDIT THIS FILE, IT IS GENERATED AND WILL BE OVERWRITTEN:",
            "// https://github.com/ccxt/ccxt/blob/master/CONTRIBUTING.md#how-to-contribute-code",
            ""
        ]
    }

    getJavaImports(file: any, ws = false) {
        if (ws) {
            // For WS pro exchanges — no import of REST parent (use FQN to avoid name clash)
            return [
                'package io.github.ccxt.exchanges.pro;',
                'import io.github.ccxt.base.Precise;',
                'import io.github.ccxt.errors.*;',
                'import io.github.ccxt.Helpers;',
                'import io.github.ccxt.ws.*;',
                'import io.github.ccxt.Client;',
            ];
        }
        const values = [
            'package io.github.ccxt.exchanges;',
            `import io.github.ccxt.api.${this.capitalize(file)}Api;`,
            'import io.github.ccxt.base.Precise;',
            'import io.github.ccxt.errors.*;',
            'import io.github.ccxt.Helpers;'
        ]
        return values;
    }

    isObject(type: string) {
        return (type === 'any') || (type === 'unknown');
    }

    isDictionary(type: string): boolean {
        return (type === 'Object') || (type === 'Dictionary<any>') || (type === 'unknown') || (type === 'Dict') || ((type.startsWith('{')) && (type.endsWith('}')))
    }

    isStringType(type: string) {
        return (type === 'Str') || (type === 'string') || (type === 'StringLiteral') || (type === 'StringLiteralType') || (type.startsWith('"') && type.endsWith('"')) || (type.startsWith("'") && type.endsWith("'"))
    }

    isNumberType(type: string) {
        return (type === 'Num') || (type === 'number') || (type === 'NumericLiteral') || (type === 'NumericLiteralType')
    }

    isIntegerType(type: string) {
        return type !== undefined && (type.toLowerCase() === 'int') ;
    }

    isBooleanType(type: string) {
        return (type === 'boolean') || (type === 'BooleanLiteral') || (type === 'BooleanLiteralType') || (type === 'Bool')
    }

    convertJavascriptTypeToCsharpType(name: string, type: string, isReturn = false): string | undefined {

        // handle watchOrderBook exception here (watchOrderBook and watchOrderBookForSymbols)
        if (name.startsWith('watchOrderBook')) {
            return `Task<ccxt.pro.IOrderBook>`;
        }

        if (name === 'watchOHLCVForSymbols') {
            return `Task<Dictionary<string, Dictionary<string, List<OHLCV>>>>`;
        }

        if (name === 'fetchTime'){
            return `Task<Int64>`; // custom handling for now
        }

        const isPromise = type.startsWith('Promise<') && type.endsWith('>');
        let wrappedType = isPromise ? type.substring(8, type.length - 1) : type;
        let isList = false;

        function addTaskIfNeeded(type: string) {
            if (type == 'void') {
                return isPromise ? `Task` : 'void';
            } else if (isList) {
                return isPromise ? `Task<List<${type}>>` : `List<${type}>`;
            }
            return isPromise ? `Task<${type}>` : type;
        }

        const csharpReplacements: dict = {
            'OrderType': 'string',
            'OrderSide': 'string', // tmp
        }

        if (wrappedType === undefined || wrappedType === 'Undefined') {
            return addTaskIfNeeded('object'); // default if type is unknown;
        }

        if (wrappedType === 'string[][]') {
            return addTaskIfNeeded('List<List<string>>');
        }

        // check if returns a list
        if (wrappedType.endsWith('[]')) {
            isList = true;
            wrappedType = wrappedType.substring(0, wrappedType.length - 2);
        }

        if (this.isObject(wrappedType)) {
            if (isReturn) {
                return addTaskIfNeeded('Dictionary<string, object>');
            }
            return addTaskIfNeeded('object');
        }
        if (this.isDictionary(wrappedType)) {
            return addTaskIfNeeded('Dictionary<string, object>');
        }
        if (this.isStringType(wrappedType)) {
            return addTaskIfNeeded('string');
        }
        if (this.isIntegerType(wrappedType)) {
            return addTaskIfNeeded('Int64');
        }
        if (this.isNumberType(wrappedType)) {
            // return addTaskIfNeeded('float');
            return addTaskIfNeeded('double');
        }
        if (this.isBooleanType(wrappedType)) {
            return addTaskIfNeeded('bool');
        }
        if (wrappedType === 'Strings') {
            return addTaskIfNeeded('List<String>')
        }
        if (csharpReplacements[wrappedType] !== undefined) {
            return addTaskIfNeeded(csharpReplacements[wrappedType]);
        }

        if (wrappedType.startsWith('Dictionary<')) {
            let type = wrappedType.substring(11, wrappedType.length - 1);
            if (type.startsWith('Dictionary<')) {
                type = this.convertJavascriptTypeToCsharpType(name, type) as any;
            }
            return addTaskIfNeeded(`Dictionary<string, ${type}>`);
        }

        return addTaskIfNeeded(wrappedType);
    }

    safeCsharpName(name: string): string {
        const csharpReservedWordsReplacement: dict = {
            'params': 'parameters',
            'base': 'baseArg',
        }
        return csharpReservedWordsReplacement[name] || name;
    }

    convertJavascriptParamToCsharpParam(param: any): string | undefined {
        const name = param.name;
        const safeName = this.safeCsharpName(name);
        const isOptional =  param.optional || param.initializer !== undefined;
        const op = isOptional ? '?' : '';
        let paramType: any = undefined;
        
        // Special case for setMarketsFromExchange method
        if (name === 'sourceExchange' && param.type === undefined) {
            paramType = 'Exchange';
        } else if (param.type == undefined) {
            paramType = 'object';
        } else {
            paramType = this.convertJavascriptTypeToCsharpType(name, param.type);
        }
        const isNonNullableType = this.isNumberType(param.type) || this.isBooleanType(param.type) || this.isIntegerType(param.type);
        if (isNonNullableType) {
            if (isOptional) {
                if (param.initializer !== undefined && param.initializer !== 'undefined') {
                    return `${paramType} ${safeName} = ${param.initializer}`
                } else {
                    if (paramType  === 'bool') {
                        return `${paramType}? ${safeName} = false`
                    }
                    if (paramType === 'double' || paramType  === 'float') {
                        return `${paramType}? ${safeName}2 = 0`
                    }
                    if (paramType  === 'Int64') {
                        return `${paramType}? ${safeName}2 = 0`
                    }
                    return `${paramType}? ${safeName}`
                }
            }
        } else {
            if (isOptional) {
                if (param.initializer !== undefined) {
                        if (param.initializer === 'undefined' || param.initializer === '{}' || paramType === 'object') {
                            return `${paramType} ${safeName} = null`
                        }
                        return `${paramType} ${safeName} = ${param.initializer.replaceAll("'", '"')}`
                }
            } else {
                return `${paramType} ${safeName}`
            }
        }
        return `${paramType}${op} ${safeName}`
    }

    shouldCreateWrapper(methodName: string, isWs = false): boolean {
        const allowedPrefixes = [
            'fetch',
            'create',
            'edit',
            'cancel',
            'setP',
            'setM',
            'setL',
            'transfer',
            'withdraw',
            'watch',
            // 'load',
        ];
        // const allowedPrefixesWs = [
        //     ''
        // ]
        const blacklistMethods = [
            'fetch',
            'setSandBoxMode',
            'loadOrderBook',
            'fetchCurrencies',
            'loadMarketsHelper',
            'createNetworksByIdObject',
            'setMarketsFromExchange',
            'setProperty',
            'setProxyAgents',
            'watch',
            'watchMultipleSubscription',
            'watchMultiple',
            'watchPrivate',
            'watchPublic',
            'setPositionsCache',
            'setPositionCache'
        ] // improve this later
        if (isWs) {
            if (methodName.indexOf('Snapshot') !== -1 || methodName.indexOf('Subscription') !== -1 || methodName.indexOf('Cache') !== -1) {
                return false;
            }
        }
        const isBlackListed = blacklistMethods.includes(methodName);
        const startsWithAllowedPrefix = allowedPrefixes.some(prefix => methodName.startsWith(prefix));
        return !isBlackListed && startsWithAllowedPrefix;
    }

    unwrapTaskIfNeeded(type: string): string {
        return type.startsWith('Task<') && type.endsWith('>') ? type.substring(5, type.length - 1) : type;
    }

    unwrapListIfNeeded(type: string): string {
        return type.startsWith('List<') && type.endsWith('>') ? type.substring(5, type.length - 1) : type;
    }

    unwrapDictionaryIfNeeded(type: string): string {
        return type.startsWith('Dictionary<string,') && type.endsWith('>') ? type.substring(19, type.length - 1) : type;
    }

    createReturnStatement(methodName: string,  unwrappedType:string ) {
        // handle watchOrderBook exception here
        if (methodName.startsWith('watchOrderBook')) {
            return `return ((ccxt.pro.IOrderBook) res).Copy();`; // return copy to avoid concurrency issues
        }

        if (methodName === 'watchOHLCVForSymbols') {
            return `return Helper.ConvertToDictionaryOHLCVList(res);`
        }

        // custom handling for now
        if (methodName === 'fetchTime'){
            return `return (Int64)res;`;
        }

        // handle the typescript type Dict
        if (unwrappedType === 'Dict') {
            return `return (Dictionary<string, object>)res;`;
        }

        const needsToInstantiate = !unwrappedType.startsWith('List<') && !unwrappedType.startsWith('Dictionary<') && unwrappedType !== 'object' && unwrappedType !== 'string' && unwrappedType !== 'float' && unwrappedType !== 'bool' && unwrappedType !== 'Int64';
        let returnStatement = "";
        if (unwrappedType.startsWith('List<')) {
            if (unwrappedType === 'List<Dictionary<string, object>>') {
                returnStatement = `return ((IList<object>)res).Select(item => (item as Dictionary<string, object>)).ToList();`
            } else {
                returnStatement = `return ((IList<object>)res).Select(item => new ${this.unwrapListIfNeeded(unwrappedType)}(item)).ToList<${this.unwrapListIfNeeded(unwrappedType)}>();`
            }
        } else if (unwrappedType.startsWith('Dictionary<string,') && unwrappedType !== 'Dictionary<string, object>' && !unwrappedType.startsWith('Dictionary')) {
            const type = this.unwrapDictionaryIfNeeded(unwrappedType);
            const returnParts = [
                `var keys = ((IDictionary<string, object>)res).Keys.ToList();`,
                `        var result = new Dictionary<string, ${type}>();`,
                `        foreach (var key in keys)`,
                `        {`,
                `            result[key] = new ${type}(((IDictionary<string,object>)res)[key]);`,
                `        }`,
                `        return result;`,
            ].join("\n");
            return returnParts;
        } else {
            returnStatement =  needsToInstantiate ? `return new ${unwrappedType}(res);` :  `return ((${unwrappedType})res);`;            ;
        }
        return returnStatement;
    }

    getDefaultParamsWrappers(rawParameters: any []) {
        const res: string[] = [];

        rawParameters.forEach(param => {
            const isOptional =  param.optional || param.initializer === 'undefined';
            // const isOptional =  param.optional || param.initializer !== undefined;
            if (isOptional && (this.isIntegerType(param.type) || this.isNumberType(param.type))) {
                const decl =  `${this.inden(2)}var ${param.name} = ${param.name}2 == 0 ? null : (object)${param.name}2;`;
                res.push(decl);
            }
        });

        return res.join("\n");
    }

    inden(level: number) {
        return '    '.repeat(level);
    }

    createWrapper (exchangeName: string, methodWrapper: any, isWs = false) {
        const isAsync = methodWrapper.async;
        const methodName = methodWrapper.name;
        if (!this.shouldCreateWrapper(methodName, isWs)) {
            return ''; // skip aux methods like encodeUrl, parseOrder, etc
        }
        const methodNameCapitalized = methodName.charAt(0).toUpperCase() + methodName.slice(1);
        const returnType = this.convertJavascriptTypeToCsharpType(methodName, methodWrapper.returnType, true);
        const unwrappedType = this.unwrapTaskIfNeeded(returnType as string);
        const args: any[] = methodWrapper.parameters.map((param: any) => this.convertJavascriptParamToCsharpParam(param));
        const stringArgs = args.filter(arg => arg !== undefined).join(', ');
        const params = methodWrapper.parameters.map((param: any) => this.safeCsharpName(param.name)).join(', ');

        const one = this.inden(1);
        const two = this.inden(2);
        const methodDoc = [] as any[];
        if (csharpComments[exchangeName] && csharpComments[exchangeName][methodName]) {
            methodDoc.push(csharpComments[exchangeName][methodName]);
        }
        const method = [
            `${one}public ${isAsync ? 'async ' : ''}${returnType} ${methodNameCapitalized}(${stringArgs})`,
            `${one}{`,
            this.getDefaultParamsWrappers(methodWrapper.parameters),
            `${two}var res = ${isAsync ? 'await ' : ''}this.${methodName}(${params});`,
            `${two}${this.createReturnStatement(methodName, unwrappedType)}`,
            `${one}}`
        ];
        return methodDoc.concat(method).filter(e => !!e).join('\n')
    }

    createExchangesWrappers(): string[] {
        // in csharp classes should be Capitalized, so I'm creating a wrapper class for each exchange
        const res: string[] = ['// class wrappers'];
        exchangeIds.forEach(exchange => {
            const capitalizedExchange = exchange.charAt(0).toUpperCase() + exchange.slice(1);
            const capitalName = capitalizedExchange.replace('.ts','');
            const constructor = `public ${capitalName}(object args = null) : base(args) { }`
            res.push(`public class  ${capitalName}: ${exchange.replace('.ts','')} { ${constructor} }`)
        });
        return res;
    }

    createJavaWrappers(exchange:string, path: string, wrappers: any[], ws = false) {
        const wrappersIndented = wrappers.map(wrapper => this.createWrapper(exchange, wrapper, ws)).filter(wrapper => wrapper !== '').join('\n');
        const shouldCreateClassWrappers = exchange === 'Exchange';
        const classes = shouldCreateClassWrappers ? this.createExchangesWrappers().filter(e=> !!e).join('\n') : '';
        // const exchangeName = ws ? exchange + 'Ws' : exchange;
        const namespace = ws ? 'namespace ccxt.pro;' : 'namespace ccxt;';
        const capitizedName = exchange.charAt(0).toUpperCase() + exchange.slice(1);
        const capitalizeStatement = ws ? `public class  ${capitizedName}: ${exchange} { public ${capitizedName}(object args = null) : base(args) { } }` : '';
        const file = [
            namespace,
            '',
            this.createGeneratedHeader().join('\n'),
            capitalizeStatement,
            `public partial class ${exchange}`,
            '{',
            wrappersIndented,
            '}',
            classes
        ].join('\n')
        log.magenta ('→', (path as any).yellow)

        overwriteFileAndFolder (path, file);
    }

    transpileErrorHierarchy () {

        const errorHierarchyFilename = './js/src/base/errorHierarchy.js'
        const errorHierarchyPath = __dirname + '/.' + errorHierarchyFilename

        let js = fs.readFileSync (errorHierarchyPath, 'utf8')

        js = this.regexAll (js, [
            // [ /export { [^\;]+\s*\}\n/s, '' ], // new esm
            [ /\s*export default[^\n]+;\n/g, '' ],
            // [ /module\.exports = [^\;]+\;\n/s, '' ], // old commonjs
        ]).trim ()

        const message = 'Transpiling error hierachy →'
        const root = errorHierarchy['BaseError']

        // a helper to generate a list of exception class declarations
        // properly derived from corresponding parent classes according
        // to the error hierarchy

        function intellisense (map: any, parent: any, generate: any, classes: any) {
            function* generator(map: any, parent: any, generate: any, classes: any): any {
                for (const key in map) {
                    yield generate (key, parent, classes)
                    yield* generator (map[key], key, generate, classes)
                }
            }
            return Array.from (generator (map, parent, generate, classes))
        }


        // JAVA ----------------------------------------------------------------

        // ---------------------------------------------------------------------

        function javaMakeErrorClassFile (name: string, parent: string) {
            const exception =
`public class ${name} extends ${parent}
{
    public ${name}() { super(); }
    public ${name}(String message) { super(message); }
    public ${name}(String message, ${parent} inner) { super(message, inner); }
}`;
            return exception
        }

            const javaBaseError =
`public class BaseError extends RuntimeException
{
    public BaseError() { super(); }
    public BaseError(String message) { super(message); }
    public BaseError(String message, Throwable cause) { super(message, cause); }
}`;

        const javaErrors = intellisense (root as any, 'BaseError', javaMakeErrorClassFile, undefined)
        const allErrors = [javaBaseError].concat (javaErrors)
        for (let i = 0; i < allErrors.length; i++) {
            const error = allErrors[i];
            const groups = error.match(/class (\w+) extends (\w+)/);
            const errorName = groups[1];
            const baseError = groups[2];
            const file = [
                'package io.github.ccxt.errors;',
                this.createGeneratedHeader().join('\n'),
                error
            ].join('\n')

            const fileName = ERRORS_FOLDER + this.capitalize(errorName) + '.java'
            log.bright.cyan (message, (fileName as any).yellow)
            overwriteFileAndFolder (fileName, file)
        }
        // const javaBodyIntellisense = '\npackage io.github.ccxt;\n' + this.createGeneratedHeader().join('\n') + '\n' + javaBaseError + '\n' + javaErrors.join ('\n') + '\n'
        // if (fs.existsSync (ERRORS_FILE)) {
        //     log.bright.cyan (message, (ERRORS_FILE as any).yellow)
        //     overwriteFileAndFolder (ERRORS_FILE, javaBodyIntellisense)
        // }
        // log.bright.cyan (message, (ERRORS_FILE as any).yellow)
    }

    transpileBaseMethods(baseExchangeFile: string) {
        const javaExchangeBase = BASE_METHODS_FILE;
        const delimiter = 'METHODS BELOW THIS LINE ARE TRANSPILED FROM TYPESCRIPT'

        const baseFile: any = this.transpiler.transpileJavaByPath(baseExchangeFile);
        let baseClass = baseFile.content as any;// remove this later

        // custom transformations needed for Java
        baseClass = baseClass.replace(/(put\("\w+",\s*)(this\.\w+)/gm, "$1Exchange.$2");
        baseClass = this.regexAll(baseClass, [
            [/\(Object client, /g, '(Client client, '],
            [/Object client = (.+)/g, 'Client client = (Client)$1'],
            [/(\w+)(\.storeArray\(.+\))/gm, '((IOrderBookSide)$1)$2'],
            [/(\b\w*)RestInstance.describe/g, "(\(Exchange\)$1RestInstance).describe"],

            // [/(put\(\s*"\w+", )(this\.\w+)/gm, "$1Exchange.$2"],
            [/public Object setMarketsFromExchange\(Object sourceExchange\)/g, "public Object setMarketsFromExchange(Exchange sourceExchange)"]
        ]);

        // // WS fixes
        // baseClass = baseClass.replace(/\(object client,/gm, '(WebSocketClient client,');

        const javaDelimiter = '// ' + delimiter + '\n';
        const restOfFile = '([^\n]*\n)+'
        const parts = baseClass.split (javaDelimiter)
        if (parts.length > 1) {
            log.magenta ('→', (javaExchangeBase as any).yellow)
            replaceInFile(javaExchangeBase, new RegExp(javaDelimiter + restOfFile), javaDelimiter + '\n' + parts[1].trim() + '\n')
        }
    }

    camelize(str: string) {
        var res =  str.replace(/(?:^\w|[A-Z]|\b\w|\s+)/g, function(match, index) {
          if (+match === 0) return ""; // or if (/\s+/.test(match)) for white spaces
          return index === 0 ? match.toLowerCase() : match.toUpperCase();
        });
        return res.replaceAll('-', '');
      }


    getCsharpExamplesWarning() {
        return [
            '',
            '    // !!Warning!! This example was automatically transpiled',
            '    // from the TS version, meaning that the code is overly',
            '    // complex and illegible compared to the code you would need to write',
            '    // normally. Use it only to get an idea of how things are done.',
            '    // Additionally always choose the typed version of the method instead of the generic one',
            '    // (e.g. CreateOrder (typed) instead of createOrder (generic)',
            ''
        ].join('\n')
    }

    transpileExamples () {
        return;
        // currently disabled!, the generated code is too complex and illegible
        const transpileFlagPhrase = '// AUTO-TRANSPILE //'

        const allTsExamplesFiles = fs.readdirSync (EXAMPLES_INPUT_FOLDER).filter((f) => f.endsWith('.ts'));
        for (const filenameWithExtenstion of allTsExamplesFiles) {
            const tsFile = path.join (EXAMPLES_INPUT_FOLDER, filenameWithExtenstion)
            let tsContent = fs.readFileSync (tsFile).toString ()
            if (tsContent.indexOf (transpileFlagPhrase) > -1) {
                const fileName = filenameWithExtenstion.replace ('.ts', '')
                log.magenta ('[C#] Transpiling example from', (tsFile as any).yellow)
                const csharp = this.transpiler.transpileCSharp(tsContent);

                const transpiledFixed = this.regexAll(
                    csharp.content,
                    [
                        [/object exchange/, 'Exchange exchange'],
                        [/async public Task example/gm, 'async public Task ' + this.camelize(fileName)],
                        [/(^\s+)object\s(\w+)\s=/gm, '$1var $2 ='],
                        [/^await.+$/gm, '']
                    ]
                )

                const finalFile = [
                    'using ccxt;',
                    'using ccxt.pro;',
                    'namespace examples;',
                    // this.getCsharpExamplesWarning(),
                    'partial class Examples',
                    '{',
                    transpiledFixed,
                    '}'
                ].join('\n');

                overwriteFileAndFolder (EXAMPLES_OUTPUT_FOLDER + fileName + '.cs', finalFile);
            }
        }
    }

    async transpileWS(force = false) {
        const tsFolder = './ts/src/pro/';

        let inputExchanges: string[] =  process.argv.slice (2).filter (x => !x.startsWith ('--'));
        if (!inputExchanges || inputExchanges.length === 0) {
            // Only transpile WS exchanges that have a REST parent class already transpiled
            const restExchanges = fs.readdirSync(EXCHANGES_FOLDER)
                .filter((f: string) => f.endsWith('.java'))
                .map((f: string) => f.replace('.java', '').toLowerCase());
            const wsExchanges = (exchanges as any).ws as string[];
            inputExchanges = wsExchanges.filter((ws: string) => restExchanges.includes(ws));
            log.blue('[java-ws] Filtering to exchanges with REST parents:', inputExchanges);
        }
        const options = { csharpFolder: EXCHANGES_WS_FOLDER, exchanges: inputExchanges }
        await this.transpileDerivedExchangeFiles (tsFolder, options, '.ts', force, !!(inputExchanges), true)
    }

    async transpileEverything (force = false, child = false, baseOnly = false, examplesOnly = false) {

        const exchanges = process.argv.slice (2).filter (x => !x.startsWith ('--'))
            , javaFolder = EXCHANGES_FOLDER
            , tsFolder = './ts/src/'
            , exchangeBase = './ts/src/base/Exchange.ts'

        if (!child) {
            createFolderRecursively (javaFolder)
        }
        const transpilingSingleExchange = (exchanges.length === 1); // when transpiling single exchange, we can skip some steps because this is only used for testing/debugging
        if (transpilingSingleExchange) {
            force = true; // when transpiling single exchange, we always force
        }
        const options = { csharpFolder: javaFolder, exchanges }

        if (!baseOnly && !examplesOnly) {
            await this.transpileDerivedExchangeFiles (tsFolder, options, '.ts', force, !!(child || exchanges.length))
        }

        if (transpilingSingleExchange) {
            return;
        }
        if (child) {
            return;
        }

        this.transpileBaseMethods (exchangeBase)

        if (baseOnly) {
            return;
        }


        this.transpileTests()

        this.transpileErrorHierarchy ()

        log.bright.green ('Transpiled successfully.')
    }

    async webworkerTranspile (allFiles: any[], parserConfig: any) {

        // create worker
        const piscina = new Piscina({
            filename: resolve(__dirname, 'java-worker.js')
        });

        const chunkSize = 20;
        const promises: any = [];
        const now = Date.now();
        for (let i = 0; i < allFiles.length; i += chunkSize) {
            const chunk = allFiles.slice(i, i + chunkSize);
            promises.push(piscina.run({transpilerConfig:parserConfig, files:chunk}));
        }
        const workerResult = await Promise.all(promises);
        const elapsed = Date.now() - now;
        log.green ('[ast-transpiler] Transpiled', allFiles.length, 'files in', elapsed, 'ms');
        const flatResult = workerResult.flat();
        return flatResult;
    }

    async transpileDerivedExchangeFiles (jsFolder: string, options: any, pattern = '.ts', force = false, child = false, ws = false) {

        // todo normalize jsFolder and other arguments

        // exchanges.json accounts for ids included in exchanges.cfg
        let ids: string[] = []
        try {
            ids = (exchanges as any).ids
        } catch (e) {
        }

        const regex = new RegExp (pattern.replace (/[.*+?^${}()|[\]\\]/g, '\\$&'))

        // let exchanges
        if (options.exchanges && options.exchanges.length) {
            exchanges = options.exchanges.map ((x: string) => x + pattern)
        } else {
            exchanges = fs.readdirSync (jsFolder).filter (file => file.match (regex) && (!ids || ids.includes (basename (file, '.ts'))))
        }

        // transpile using webworker
        const allFilesPath = exchanges.map ((file: string) => jsFolder + file );
        // const transpiledFiles =  await this.webworkerTranspile(allFilesPath, this.getTranspilerConfig());
        log.blue('[java] Transpiling [', exchanges.join(', '), ']');
        const transpiledFiles =  allFilesPath.map((file: string) => this.transpiler.transpileJavaByPath(file));

        if (!ws) {
            for (let i = 0; i < transpiledFiles.length; i++) {
                // const transpiled = transpiledFiles[i];
                // const exchangeName = exchanges[i].replace('.ts','');
                // const path = EXCHANGE_WRAPPER_FOLDER + this.capitalizeexchangeName + '.java';
                // // this.createCSharpWrappers(exchangeName, path, transpiled.methodsTypes)
            }
        } else {
            //
            for (let i = 0; i < transpiledFiles.length; i++) {
                // const transpiled = transpiledFiles[i];
                // const exchangeName = exchanges[i].replace('.ts','');
                // const path = EXCHANGE_WS_WRAPPER_FOLDER + exchangeName + '.cs';
                // this.createCSharpWrappers(exchangeName, path, transpiled.methodsTypes, true)
            }
        }
        exchanges.map ((file: string, idx: number) => this.transpileDerivedExchangeFile (jsFolder, file, options, transpiledFiles[idx], force, ws))

        const classes = {}

        return classes
    }

    createJavaClass(name: string, javaVersion: any, ws = false) {
        const javaImports = this.getJavaImports(name, ws).join("\n") + "\n\n";
        let content = javaVersion.content;

        // inject constructor
        const constructor = [
        '',
        `   public ${this.capitalize(name)} () {`,
        `       super();`,
        `   }`,
        '',
        `   public ${this.capitalize(name)} (Object options) {`,
        `       super(options);`,
        `   }`,
        ''
        ].join('\n');

        const regex = /class (\w+) extends (\w+)/
        // const res = content.match(regex)
        // const parentExchange = res[1].toLowerCase();
        // override extends from Exchange to ClassApi
        content = content.replace(/extends\s\w+/g, `extends ${this.capitalize(name)}Api`);
        content = content.replace(/, (sha1|sha384|sha512|sha256|md5|ed25519|keccak|p256|secp256k1)([,)])/g, `, $1()$2`);
        content = content.replace(/(\s+public Object describe\(\))/g,`${constructor}$1`)

        // const baseWsClassRegex = /class\s(\w+)\s+:\s(\w+)/;
        // const baseWsClassExec = baseWsClassRegex.exec(content);
        // const baseWsClass = baseWsClassExec ? baseWsClassExec[2] : '';
        // if (!ws) {
        //     content = content.replace(/class\s(\w+)\s:\s(\w+)/gm, "public partial class $1 : $2");
        // } else {
        //     const wsParent =  baseWsClass.endsWith('Rest') ? 'ccxt.' + baseWsClass.replace('Rest', '') : baseWsClass;
        //     content = content.replace(/class\s(\w+)\s:\s(\w+)/gm, `public partial class $1 : ${wsParent}`);
        // }
        // content = content.replace(/binaryMessage.byteLength/gm, 'getValue(binaryMessage, "byteLength")'); // idex tmp fix
        // WS fixes
        if (ws) {
            const wsRegexes = this.getJavaWsRegexes();
            content = this.regexAll (content, wsRegexes);
            content = this.replaceImportedRestClasses (content, javaVersion.imports);
            // For WS classes, use FQN for REST parent to avoid same-name conflict
            const restFqn = `io.github.ccxt.exchanges.${this.capitalize(name)}`;
            content = content.replace(/extends\s\w+Api/g, `extends ${restFqn}`);
            content = content.replace(/extends\s(\w+)Rest/g, `extends io.github.ccxt.exchanges.$1`);
            content = content.replace(/extends\s(\w+)\b(?!\.)/, `extends ${restFqn}`);
            content = this.postProcessWsJava(content, name);
        }
        content = this.createGeneratedHeader().join('\n') + '\n' + content;
        return javaImports + content;
    }

    postProcessWsJava(content: string, name: string): string {
        const cap = this.capitalize(name);

        // ── Pattern 12: Map casts for client.subscriptions/futures access ──
        content = content.replace(/\(\(Object\)client\)\.subscriptions/gm, '((java.util.Map)client.subscriptions)');
        content = content.replace(/\(\(Object\)client\)\.futures/gm, '((java.util.Map)client.futures)');
        // Direct access without cast
        content = content.replace(/client\.subscriptions\.remove\(/gm, '((java.util.Map<String,Object>)client.subscriptions).remove(');
        content = content.replace(/client\.subscriptions\.keySet\(/gm, '((java.util.Map<String,Object>)client.subscriptions).keySet(');

        // ── Pattern 6: Method reference for ping ──
        content = content.replace(new RegExp(`${cap}\\.this::ping`, 'gm'),
            `(java.util.function.Function<Client, Object>) ${cap}.this::ping`);

        // ── Pattern 1+2: client.future() / client.reusableFuture() return Future ──
        // Object future = client.future(x) → io.github.ccxt.ws.Future future = client.future((String)x)
        content = content.replace(/Object\s+future\s*=\s*client\.(future|reusableFuture)\((\w+)\)/gm,
            'io.github.ccxt.ws.Future future = client.$1((String)$2)');
        // Object future = Helpers.GetValue(client.futures, x) → cast to Future
        content = content.replace(/Object\s+future\s*=\s*Helpers\.GetValue\(client\.futures,\s*(\w+)\)/gm,
            'io.github.ccxt.ws.Future future = (io.github.ccxt.ws.Future)Helpers.GetValue(client.futures, $1)');

        // ── Pattern 3: (String) cast on messageHash for client.future() / reusableFuture() ──
        // client.future(messageHash) where messageHash is Object
        content = content.replace(/client\.(future|reusableFuture)\(messageHash\)/gm, 'client.$1((String)messageHash)');

        // ── Pattern 2: future.join() → future.getFuture().join() ──
        // Only for local `future` variables (not this.xxx)
        content = content.replace(/(?<!\w)(future)\.join\(\)/gm, 'future.getFuture().join()');
        // (future).join() pattern
        content = content.replace(/\(future\)\.join\(\)/gm, 'future.getFuture().join()');
        // client.future(...).join() → client.future(...).getFuture().join()
        content = content.replace(/client\.(future|reusableFuture)\(([^)]+)\)\.join\(\)/gm,
            'client.$1($2).getFuture().join()');

        // ── Pattern 10: (String) cast on Helpers.add() for exception constructors and client.future() ──
        content = content.replace(/(throw new \w+\()Helpers\.add\(/gm, '$1(String)Helpers.add(');
        content = content.replace(/(client\.(?:future|reusableFuture)\()Helpers\.add\(/gm, '$1(String)Helpers.add(');

        // ── Pattern 5: ArrayCache .hashmap access ──
        // Only match local variables, not this.xxx
        content = content.replace(/(?<!this\.)(?<![\w.])([a-z]\w+)\.hashmap\b/gm, '((io.github.ccxt.ws.ArrayCache)$1).hashmap');
        // this.xxx.hashmap → ((ArrayCache)this.xxx).hashmap
        content = content.replace(/(this\.\w+)\.hashmap\b/gm, '((io.github.ccxt.ws.ArrayCache)$1).hashmap');
        // Prevent double-wrapping
        content = content.replace(/\(\(io\.github\.ccxt\.ws\.ArrayCache\)\(\(io\.github\.ccxt\.ws\.ArrayCache\)/gm,
            '((io.github.ccxt.ws.ArrayCache)');

        // ── Pattern: future.resolve(...) on Object-typed future variable ──
        // future.resolve(x) where future is Object → cast
        content = content.replace(/(?<!\w)future\.resolve\(([^)]+)\)/gm,
            '((io.github.ccxt.ws.Future)future).resolve($1)');
        // future.reject(x) on Object
        content = content.replace(/(?<!\w)future\.reject\(([^)]+)\)/gm,
            '((io.github.ccxt.ws.Future)future).reject($1)');

        // ── Dynamic method dispatch for Object-typed variables ──
        // Dynamic method calls on Object-typed variables — use balanced paren matching
        const dynamicMethods = ['append', 'reset', 'storeArray', 'store', 'getLimit'];
        for (const method of dynamicMethods) {
            content = this.replaceDynamicMethodCall(content, method);
        }
        content = content.replace(/(?<!this\.)(?<!Helpers\.)(?<![\w.])([a-z]\w+)\.limit\(\)/gm,
            'Helpers.callDynamically($1, "limit", new Object[]{})');

        // ── Property access on Object-typed variables ──
        content = content.replace(/(?<![.\w])([a-z]\w+)\.cache\b(?!\()/gm,
            '((java.util.List<Object>)Helpers.GetValue($1, "cache"))');
        content = content.replace(/(?<![.\w])([a-z]\w+)\.nonce\b(?!\()/gm, 'Helpers.GetValue($1, "nonce")');

        // ── Method references in subscription maps → string name ──
        content = content.replace(new RegExp(`${cap}\\.this\\.(handle\\w+)\\s*(?=[,;)\\s])`, 'gm'), '"$1"');
        // Also match this.handleXyz as a value (not a call)
        content = content.replace(/(?<!=\s)this\.(handle\w+)\s*(?=[,;)\s])/gm, '"$1"');
        // method = this.handleXyz; → method = "handleXyz";
        content = content.replace(/=\s*this\.(handle\w+)\s*;/gm, '= "$1";');
        // Also for non-handle methods used as references: this.ping, this.negotiate etc
        content = content.replace(new RegExp(`${cap}\\.this\\.(\\w+)\\s*(?=[,;)](?!\\s*\\())`, 'gm'), '"$1"');

        // ── .call(this, args) → reflection dispatch — use balanced parens ──
        content = this.replaceCallPattern(content);

        // ── this.spawn(this.method, args) → lambda ──
        // Careful: capture args up to the matching closing ) of spawn(), not beyond
        content = content.replace(/this\.spawn\(this\.(\w+),\s*([^)]*(?:\([^)]*\)[^)]*)*)\);/gm, (match: string, method: string, args: string) => {
            return `this.spawn(() -> { try { this.${method}(${args}); } catch(Exception _e) { throw new RuntimeException(_e); } });`;
        });

        // ── watch/watchMultiple missing 5th arg ──
        // Use balanced paren counting for accurate arg detection
        for (const method of ['watch', 'watchMultiple']) {
            const pattern = new RegExp(`this\\.${method}\\(`, 'g');
            let result2 = '';
            let lastIdx2 = 0;
            let m2;
            while ((m2 = pattern.exec(content)) !== null) {
                const startIdx = m2.index + m2[0].length;
                let depth2 = 1;
                let j2 = startIdx;
                while (j2 < content.length && depth2 > 0) {
                    if (content[j2] === '(') depth2++;
                    if (content[j2] === ')') depth2--;
                    j2++;
                }
                const args2 = content.substring(startIdx, j2 - 1);
                // Count top-level commas (not inside nested parens)
                let topLevelCommas = 0;
                let d = 0;
                for (const ch of args2) {
                    if (ch === '(') d++;
                    if (ch === ')') d--;
                    if (ch === ',' && d === 0) topLevelCommas++;
                }
                const argCount = topLevelCommas + 1;
                result2 += content.substring(lastIdx2, m2.index);
                if (argCount === 4) {
                    result2 += `this.${method}(${args2}, null)`;
                } else if (argCount === 3) {
                    result2 += `this.${method}(${args2}, null, null)`;
                } else {
                    result2 += `this.${method}(${args2})`;
                }
                lastIdx2 = j2;
            }
            result2 += content.substring(lastIdx2);
            content = result2;
        }

        // ── Client type handling ──
        content = content.replace(/WsClient\b/gm, 'Client');
        content = content.replace(/\(Object client\)/gm, '(Client client)');
        content = content.replace(/\(Object client,/gm, '(Client client,');
        content = content.replace(/Object client =/gm, 'Client client =');
        content = content.replace(/Object client = this\.client\(/gm, 'Client client = this.client(');
        // Client client = Helpers.GetValue(clients, i) pattern
        content = content.replace(/Client\s+client\s*=\s*Helpers\.GetValue\((\w+),\s*(\w+)\)/gm,
            'Client client = (Client)Helpers.GetValue($1, $2)');

        // ── Pattern 9: int/long from Object ──
        content = content.replace(/int (\w+) = (?![\d(])/gm, 'Object $1 = ');
        // client.lastPong = this.safeInteger(...) → needs Number cast
        content = content.replace(/client\.lastPong\s*=\s*(this\.safe\w+\([^;]+);/gm,
            'client.lastPong = ((Number)$1).longValue();');

        // ── this.delay → spawn with sleep ──
        content = content.replace(/this\.delay\(([^,]+),\s*this\.(\w+),\s*([^)]+)\)/gm,
            'this.spawn(() -> { try { Thread.sleep(((Number)$1).longValue()); this.$2($3); } catch(Exception _e) {} })');

        // ── String type fixes ──
        content = content.replace(/String (\w+) = ((?:this\.\w+\(|Helpers\.)[^;]+);/gm, 'Object $1 = $2;');

        // ── CompletableFuture<Void> → <Object> ──
        content = content.replace(/CompletableFuture<Void>/gm, 'CompletableFuture<Object>');

        // ── this.lockId()/this.unlockId() → synchronized ──
        // Bybit-specific: replace lockId/unlockId pair with synchronized block
        content = content.replace(/this\.lockId\(\);/gm, 'synchronized (this) {');
        content = content.replace(/this\.unlockId\(\);/gm, '}');

        // ── Pattern 7: Lambda capture variables ──
        // Instead of complex analysis, simply make ALL local Object variables
        // that are reassigned before a supplyAsync effectively final.
        // Simpler approach: find variables that are reassigned (x = ...)
        // and add final copies before the FIRST supplyAsync that captures them.
        // For now, skip this complex transformation — the exchanges that need it
        // are few and the fix can be done via regex on the specific pattern:
        // Add "final" keyword to variable declarations that are captured in anonymous inner classes
        // This is handled by the Java compiler's "effectively final" check — most variables
        // ARE effectively final. Only reassigned ones need fixing.
        // We handle this by converting reassigned variables to use a final copy pattern.

        // ── Void supplyAsync return null insertion ──
        const lines3 = content.split('\n');
        for (let i = 0; i < lines3.length; i++) {
            if (lines3[i].trim().startsWith('}, io.github.ccxt.Exchange.VIRTUAL_EXECUTOR)')) {
                let j = i - 1;
                while (j >= 0 && lines3[j].trim() === '') j--;
                if (j >= 0 && lines3[j].trim() === '}') {
                    let k = j - 1;
                    while (k >= 0 && lines3[k].trim() === '') k--;
                    if (k >= 0 && !lines3[k].trim().startsWith('return ') && !lines3[k].trim().startsWith('return(')) {
                        const indent = lines3[j].match(/^\s*/)?.[0] || '';
                        lines3.splice(j, 0, indent + '    return null;');
                        i++;
                    }
                }
            }
        }
        // Also replace bare "return;" inside supplyAsync with "return null;"
        // But only inside supplyAsync blocks (between supplyAsync and VIRTUAL_EXECUTOR)
        let inSupplyAsync = 0;
        for (let i = 0; i < lines3.length; i++) {
            if (lines3[i].includes('CompletableFuture.supplyAsync')) inSupplyAsync++;
            if (lines3[i].includes('VIRTUAL_EXECUTOR)')) inSupplyAsync = Math.max(0, inSupplyAsync - 1);
            if (inSupplyAsync > 0 && lines3[i].trim() === 'return;') {
                lines3[i] = lines3[i].replace('return;', 'return null;');
            }
        }
        content = lines3.join('\n');

        return content;
    }

    replaceCallPattern(content: string): string {
        // handler.call(this, args) → Helpers.callDynamically(this, handler, new Object[]{args})
        const pattern = /(\w+)\.call\(this,\s*/g;
        let result = '';
        let lastIdx = 0;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            const handler = match[1];
            const startIdx = match.index + match[0].length;
            let depth = 1; // we're inside the outer ( already
            let i = startIdx;
            while (i < content.length && depth > 0) {
                if (content[i] === '(') depth++;
                if (content[i] === ')') depth--;
                i++;
            }
            const args = content.substring(startIdx, i - 1);
            result += content.substring(lastIdx, match.index);
            result += `Helpers.callDynamically(this, ${handler}, new Object[] {${args}})`;
            lastIdx = i;
        }
        result += content.substring(lastIdx);
        return result;
    }

    replaceDynamicMethodCall(content: string, methodName: string): string {
        // Find localVar.methodName( and balance parens to find the closing )
        const pattern = new RegExp(`(?<=[^\\w.])([a-z]\\w+)\\.${methodName}\\(`, 'g');
        let result = '';
        let lastIdx = 0;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            const varName = match[1];
            // Check it's not preceded by this. or Helpers. or other qualifiers
            const before = content.substring(Math.max(0, match.index - 20), match.index);
            if (/(?:this\.|Helpers\.|new\s|\w\.)$/.test(before)) continue;
            // Skip known Java keywords and common typed variables that are NOT Object-typed
            const skipVars = ['new', 'var', 'for', 'if', 'else', 'return', 'try', 'catch', 'throw',
                'list', 'result', 'results', 'channel', 'response', 'request', 'message',
                'data', 'params', 'options', 'config', 'entry', 'item', 'key', 'value',
                'asks', 'bids', 'client', 'exchange', 'string', 'array', 'map', 'set',
                'ticker', 'trade', 'order', 'balance', 'position', 'currency', 'market'];
            if (skipVars.includes(varName)) continue;

            const startIdx = match.index + match[0].length; // after the (
            let depth = 1;
            let i = startIdx;
            while (i < content.length && depth > 0) {
                if (content[i] === '(') depth++;
                if (content[i] === ')') depth--;
                i++;
            }
            // i is now past the closing )
            const args = content.substring(startIdx, i - 1);
            result += content.substring(lastIdx, match.index);
            result += `Helpers.callDynamically(${varName}, "${methodName}", new Object[]{${args}})`;
            lastIdx = i;
        }
        result += content.substring(lastIdx);
        return result;
    }

    replaceImportedRestClasses (content: string, imports: any[]) {
        for (const imp of imports) {
            // { name: "hitbtc", path: "./hitbtc.js", isDefault: true, }
            // { name: "bequantRest", path: "../bequant.js", isDefault: true, }
            const name = imp.name;
            if (name.endsWith('Rest')) {
                content = content.replaceAll(name, 'ccxt.' + name.replace('Rest', ''));
            }
        }
        return content;
    }

    transpileDerivedExchangeFile (tsFolder: string, filename: string, options: any, csharpResult: any, force = false, ws = false) {

        const tsPath = tsFolder + filename

        const { csharpFolder: javaFolder } = options

        const javaName = filename.replace ('.ts', '.java')

        const fileNameNoExt = filename.replace ('.ts', '')

        const tsMtime = fs.statSync (tsPath).mtime.getTime ()

        const csharp  = this.createJavaClass (fileNameNoExt, csharpResult, ws)

        if (javaFolder) {
            overwriteFileAndFolder (javaFolder + this.capitalize(javaName), csharp)
        }
    }

    // ---------------------------------------------------------------------------------------------
    transpileWsOrderbookTestsToCSharp (outDir: string) {

        const jsFile = './ts/src/pro/test/base/test.orderBook.ts';
        const csharpFile = `${outDir}/Ws/test.orderBook.cs`;

        log.magenta ('Transpiling from', (jsFile as any).yellow)

        const csharp = this.transpiler.transpileCSharpByPath(jsFile);
        let content = csharp.content;
        const splitParts = content.split('// --------------------------------------------------------------------------------------------------------------------');
        splitParts.shift();
        content = splitParts.join('\n// --------------------------------------------------------------------------------------------------------------------\n');
        content = this.regexAll (content, [
            [/typeof\((\w+)\)/g,'$1'], // tmp fix
            [/object\s*(\w+)\s=\sgetValue\((\w+),\s*"(bids|asks)".+/g,'var $1 = $2.$3;'], // tmp fix
            [ /object  = functions;/g, '' ], // tmp fix
            [ /\s*public\sobject\sequals(([^}]|\n)+)+}/gm, '' ], // remove equals
            [/assert/g, 'Assert'],
        ]).trim ()

        const contentLines = content.split ('\n');
        const contentIdented = contentLines.map (line => '        ' + line).join ('\n');

        const file = [
            'using ccxt.pro;',
            'namespace Tests;',
            '',
            this.createGeneratedHeader().join('\n'),
            'public partial class BaseTest',
            '{',
            contentIdented,
            '}',
        ].join('\n')

        log.magenta ('→', (csharpFile as any).yellow)

        overwriteFileAndFolder (csharpFile, file);
    }

    // ---------------------------------------------------------------------------------------------
    transpileWsCacheTestsToCSharp (outDir: string) {

        const jsFile = './ts/src/pro/test/base/test.cache.ts';
        const csharpFile = `${outDir}/Ws/test.cache.cs`;

        log.magenta ('Transpiling from', (jsFile as any).yellow)

        const csharp = this.transpiler.transpileCSharpByPath(jsFile);
        let content = csharp.content;
        const splitParts = content.split('// ----------------------------------------------------------------------------');
        splitParts.shift();
        content = splitParts.join('\n// ----------------------------------------------------------------------------\n');
        content = this.regexAll (content, [
            [/typeof\((\w+)\)/g,'$1'], // tmp fix
            [/typeof\(timestampCache\)/g,'timestampCache'], // tmp fix
            [ /object  = functions;/g, '' ], // tmp fix
            [ /\s*public\sobject\sequals(([^}]|\n)+)+}/gm, '' ], // remove equals
            [/assert/g, 'Assert'],
        ]).trim ()

        const contentLines = content.split ('\n');
        const contentIdented = contentLines.map (line => '        ' + line).join ('\n');

        const file = [
            'using ccxt.pro;',
            'namespace Tests;',
            '',
            this.createGeneratedHeader().join('\n'),
            'public partial class BaseTest',
            '{',
            contentIdented,
            '}',
        ].join('\n')

        log.magenta ('→', (csharpFile as any).yellow)

        overwriteFileAndFolder (csharpFile, file);
    }

    // ---------------------------------------------------------------------------------------------

    transpileCryptoTestsToJava (outDir: string) {

        const jsFile = './ts/src/test/base/test.cryptography.ts';
        const csharpFile = `${outDir}/TestCryptography.java`;

        log.magenta ('[java] Transpiling from', (jsFile as any).yellow)

        const java = this.transpiler.transpileJavaByPath(jsFile);
        let content = java.content;
        content = this.regexAll (content, [
            [ /\s*public\sObject\sequals(([^}]|\n)+)+}/gm, '' ], // remove equals
            [/, (sha1|sha384|sha512|sha256|md5|ed25519|keccak|p256|secp256k1)([,)])/gm, `, $1()$2`],
            [/, (sha1|sha384|sha512|sha256|md5|ed25519|keccak|p256|secp256k1)([,)])/gm, `, $1()$2`], // quick fix to replace twice
            [/assert/g, 'Assert'],
            // [/(^\s*Assert\(equals\(ecdsa\([^;]+;)/gm, '/*\n $1\nTODO: add ecdsa\n*/'] // temporarily disable ecdsa tests
        ]).trim ()

        const contentLines = content.split ('\n');
        const contentIdented = contentLines.map (line => '        ' + line).join ('\n');


        const file = [
            'package tests.base;',
            'import tests.BaseTest;',
            'import io.github.ccxt.Helpers;',
            '',
            this.createGeneratedHeader().join('\n'),
            'public class TestCryptography extends BaseTest {',
            contentIdented,
            '}',
        ].join('\n')

        log.magenta ('→', (csharpFile as any).yellow)

        overwriteFileAndFolder (csharpFile, file);
    }

    transpileExchangeTest(name: string, path: string): [string, string] {
        const java = this.transpiler.transpileJavaByPath(path);
        let content = java.content;

        const parsedName = name.replace('.ts', '');
        const parsedParts = parsedName.split('.');
        const finalName = parsedParts[0] + this.capitalize(parsedParts[1]);

        content = this.regexAll (content, [
            [/assert/g, 'Assert'],
            [/object exchange/g, 'Exchange exchange'],
            [/function test/g, finalName],
        ]).trim ()

        const contentLines = content.split ('\n');
        const contentIdented = contentLines.map (line => '    ' + line).join ('\n');

        const className = 'Test' + this.capitalize(parsedName.replace('test.', ''))
        const file = [
            'package tests.exchange;',
            'import io.github.ccxt.Helpers;',
            'import io.github.ccxt.Exchange;',
            '',
            this.createGeneratedHeader().join('\n'),
            `public class ${className} {`,
            contentIdented,
            '}',
        ].join('\n')
        return [finalName, file];
    }

    async transpileExchangeTestsToJava() {
        const inputDir = './ts/src/test/exchange/';
        const outDir = GENERATED_TESTS_FOLDER;
        const ignore = [
            // 'exportTests.ts',
            // 'test.fetchLedger.ts',
            'test.throttler.ts',
            // 'test.fetchOrderBooks.ts', // uses spread operator
        ]

        const inputFiles = fs.readdirSync('./ts/src/test/exchange');
        const files = inputFiles.filter(file => file.match(/\.ts$/)).filter(file => !ignore.includes(file) );
        const transpiledFiles = files.map(file => this.transpileExchangeTest(file, inputDir + file));
        await Promise.all (transpiledFiles.map ((file, idx) => promisedWriteFile (outDir + file[0] + '.cs', file[1])))
    }

    transpileBaseTestsToJava () {
        const outDir = BASE_TESTS_FOLDER;
        this.transpileBaseTests(outDir);
        this.transpileCryptoTestsToJava(outDir);
        // this.transpileWsCacheTestsToCSharp(outDir);
        // this.transpileWsOrderbookTestsToCSharp(outDir);
    }

    transpileBaseTests (outDir: string) {

        const baseFolders = {
            ts: './ts/src/test/base/',
        };

        let baseFunctionTests = fs.readdirSync (baseFolders.ts).filter(filename => filename.endsWith('.ts')).map(filename => filename.replace('.ts', ''));

        for (const testName of baseFunctionTests) {
            const tsFile = baseFolders.ts + testName + '.ts';
            const tsContent = fs.readFileSync(tsFile).toString();
            if (!tsContent.includes ('// AUTO_TRANSPILE_ENABLED')) {
                continue;
            }

            const correctedTestName = 'Test' + this.capitalize(testName.replace('test.', '').replace('tests.', ''))
            const javaFile = `${outDir}/${correctedTestName}.java`;

            log.magenta ('Transpiling from', (tsFile as any).yellow)

            const java = this.transpiler.transpileJavaByPath(tsFile);
            let content = java.content;
            content = this.regexAll (content, [
                [/async public/gm, 'public'],
                [/object  = functions;/g, '' ], // tmp fix
                [/assert/g, 'Assert'],
                [ /Object exchange(?=[,)])/g, 'Exchange exchange' ],
                [/new ccxt\.Exchange/gm, 'new Exchange'],
                [ /\s*public\sObject\sequals(([^}]|\n)+)+}/gm, '' ], // remove equals
                [ /testSharedMethods.AssertDeepEqual/gm, 'AssertDeepEqual' ], // deepEqual added
            ]).trim ()

            if (correctedTestName === 'TestInit') {
                content = this.regexAll (content, [
                    [/(test(\w+))\(\)/gm, '(new Test$2()).$1()'],
                ])
            } else if (correctedTestName === 'TestSafeMethods') {
                // we don't support wS structs yet

                content = this.regexAll (content, [
                    [/\/\/ init array cache tests[\s\S]*/gm, '}'],
                ]);
            }

            const contentLines = content.split ('\n');
            const contentIdented = contentLines.map (line => '        ' + line).join ('\n');

            const usesExchange = java.content.indexOf('ccxt.Exchange') >= 0;
            const usesPrecise = java.content.indexOf('Precise.') >= 0;
            const exchangeImport = usesExchange ? 'import io.github.ccxt.Exchange;\n' : '';
            const preciseImport = usesPrecise ? 'import io.github.ccxt.base.Precise;\n' : '';
            const file = [
                'package tests.base;',
                'import tests.BaseTest;',
                'import io.github.ccxt.Helpers;',
                exchangeImport,
                preciseImport,
                this.createGeneratedHeader().join('\n'),
                `public class ${correctedTestName} extends BaseTest` ,
                '{',
                contentIdented,
                '}',
            ].join('\n')

            log.magenta ('→', (javaFile as any).yellow)

            overwriteFileAndFolder (javaFile, file);
        } 
    }

    capitalize(s: string) {
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    transpileMainTest(files: any) {
        log.magenta ('[java] Transpiling from', files.tsFile.yellow)
        let ts = fs.readFileSync (files.tsFile).toString ();

        ts = this.regexAll (ts, [
            [ /\'use strict\';?\s+/g, '' ],
        ])

        const mainContent = ts;
        const java = this.transpiler.transpileJava(mainContent);
        // let contentIndentend = csharp.content.split('\n').map(line => line ? '    ' + line : line).join('\n');
        let contentIndentend = java.content;


        // ad-hoc fixes
        contentIndentend = this.regexAll (contentIndentend, [
            [ /Object mockedExchange =/gm, 'var mockedExchange =' ],
            [ /public Object initOfflineExchange/g, 'public Exchange initOfflineExchange' ],
            [ /Object exchange(?=[,)])/g, 'Exchange exchange' ],
            [ /Object exchange =/g, 'Exchange exchange =' ],
            [ /throw new Error/g, 'throw new Exception' ],
            [ /public class TestMainClass/g, 'public class TestMain extends BaseTest'],
            [ /assert/gm, 'Assert'],
            [/TestMainClass\.this/gm, 'TestMain.this'],
            [ /throw new Exception/g, 'throw new RuntimeException' ],
            [/throw e/gm, 'throw new RuntimeException(e)'],

        ])

        const file = [
            'package tests.exchange;',
            'import io.github.ccxt.Helpers;',
            'import io.github.ccxt.Exchange;',
            'import tests.BaseTest;',
            'import io.github.ccxt.errors.*;',
            '',
            this.createGeneratedHeader().join('\n'),
            contentIndentend,
        ].join('\n')

        overwriteFileAndFolder (files.javaFile, file);
    }

    transpileExchangeTests(){
        this.transpileMainTest({
            'tsFile': './ts/src/test/tests.ts',
            'javaFile': BASE_TESTS_FILE,
        });

        const baseFolders = {
            ts: './ts/src/test/Exchange/',
            tsBase: './ts/src/test/Exchange/base/',
            javaBase: EXCHANGE_BASE_FOLDER,
            java: EXCHANGE_GENERATED_FOLDER,
        };

        let baseTests = fs.readdirSync (baseFolders.tsBase).filter(filename => filename.endsWith('.ts')).map(filename => filename.replace('.ts', ''));
        const exchangeTests = fs.readdirSync (baseFolders.ts).filter(filename => filename.endsWith('.ts')).map(filename => filename.replace('.ts', ''));

        // ignore throttle test for now
        baseTests = baseTests.filter (filename => filename !== 'test.throttle');

        const tests = [] as any;
        baseTests.forEach (baseTest => {
            let correctedName = 'Test' + this.capitalize(baseTest.replace('test.', ''));
            correctedName = correctedName.replace('Ohlcv', 'OHLCV'); // special case
            tests.push({
                base: true,
                name:baseTest,
                tsFile: baseFolders.tsBase + baseTest + '.ts',
                javaFile: baseFolders.javaBase + correctedName + '.java',
            });
        });
        exchangeTests.forEach (test => {
            const correctedName = 'Test' + this.capitalize(test.replace('test.', ''));
            tests.push({
                base: false,
                name: test,
                tsFile: baseFolders.ts + test + '.ts',
                javaFile: baseFolders.java + correctedName + '.java',
            });
        });

        this.transpileAndSaveJavaExchangeTests (tests);
    }

    transpileWsExchangeTests(){

        const baseFolders = {
            ts: './ts/src/pro/test/Exchange/',
            csharp: EXCHANGE_GENERATED_FOLDER + 'Ws/',
        };

        const wsTests = fs.readdirSync (baseFolders.ts).filter(filename => filename.endsWith('.ts')).map(filename => filename.replace('.ts', ''));

        const tests = [] as any;

        wsTests.forEach (test => {
            tests.push({
                name: test,
                tsFile: baseFolders.ts + test + '.ts',
                javaFile: baseFolders.java + test + '.java',
            });
        });

        this.transpileAndSaveJavaExchangeTests (tests, true);
    }

    async transpileAndSaveJavaExchangeTests(tests: any[], isWs = false) {
        const paths = tests.map(test => test.tsFile);
        const flatResult = await this.webworkerTranspile (paths, this.getTranspilerConfig());
        flatResult.forEach((file, idx) => {
            let contentIndentend = file.content.split('\n').map((line: string) => line ? '    ' + line : line).join('\n');
            const filename = tests[idx].name;

            let regexes = [
                [/assert/g, 'Assert'],
                [/testSharedMethods\./gm, 'TestSharedMethods.'],
                [/async public/gm, 'public'],
                [ /Object exchange(?=[,)])/g, 'Exchange exchange' ],
                [ /throw new Exception/g, 'throw new RuntimeException' ],
                [/throw e/gm, 'throw new RuntimeException(e)'],
                [/TestSharedMethods\.assertTimestampAndDatetime\(exchange, skippedProperties, method, orderbook\)/, '// testSharedMethods.assertTimestampAndDatetime (exchange, skippedProperties, method, orderbook)'], // tmp disabling timestamp check on the orderbook
                [ /void function/g, 'void'],
                [/(\w+)\.spawn\(([^,]+),(.+)\)/gm, '$1.spawn($2, new object[] {$3})'],
            ];

            if (filename.includes('fetch') || filename.includes('load') || filename.includes('create')) {
                contentIndentend = this.regexAll (contentIndentend, [
                    [/test(\w+)\(exchange,/gm, 'Test$1.test$1(exchange,'], // dirty trick recognize outside static functions, check comment below *
                ]);
            } else {
                contentIndentend = this.regexAll (contentIndentend, [
                    [/testTrade\(exchange\,/, 'TestTrade.testTrade(exchange,'], // quick fix
                ]);
            }

            //*
            // In java everything is class-based so we don't ahve independent functions laying around
            // so let's say we have the test `testFetchLedger`, it will call the aux function `testledgerEntry`
            // but that function is part of a different class.

            contentIndentend = this.regexAll (contentIndentend, regexes)
            // const namespace = isWs ? 'using ccxt;\nusing ccxt.pro;' : 'using ccxt;';
            let parsedName = 'Test' + this.capitalize(filename.replace('test.', '').replace('tests.', ''));
            if (parsedName === 'TestOhlcv') parsedName = 'TestOHLCV'; // special case
            const preciseImport = contentIndentend.indexOf('Precise.') >= 0 ? 'import io.github.ccxt.base.Precise;\n' : '';
            const fileHeaders = [
                'package tests.exchange;',
                'import tests.BaseTest;',
                'import io.github.ccxt.Helpers;',
                'import io.github.ccxt.Exchange;',
                'import io.github.ccxt.errors.*;',
                preciseImport,
                '',
                this.createGeneratedHeader().join('\n'),
                '',
                `public class ${parsedName} extends BaseTest {`,
            ]
            let java: string;
            if (filename === 'test.sharedMethods') {
                contentIndentend = this.regexAll (contentIndentend, [
                    [/public void /g, 'public static void ' ], // make tests static
                    [/public java.util.concurrent.CompletableFuture<Object> /g, 'public static java.util.concurrent.CompletableFuture<Object> ' ], // make tests static
                    [/public Object /g, 'public static Object ']
                ])
                // const doubleIndented = contentIndentend.split('\n').map((line: string) => line ? '    ' + line : line).join('\n');
                java = [
                    ...fileHeaders,
                    contentIndentend,
                    '}'
                ].join('\n');
            } else {
                contentIndentend = this.regexAll (contentIndentend, [
                    [ /public void/g, 'public static void' ], // make tests static
                    [ /async public Task/g, 'async static public Task' ], // make tests static
                    [ /public object /g, 'public static object ' ],
                ])
                java = [
                    ...fileHeaders,
                    contentIndentend,
                    '}',
                ].join('\n');
            }
            overwriteFileAndFolder (tests[idx].javaFile, java);
        });
    }

    transpileTests(){
        if (!shouldTranspileTests) {
            log.bright.yellow ('Skipping tests transpilation');
            return;
        }
        this.transpileBaseTestsToJava();
        this.transpileExchangeTests();
        // this.transpileWsExchangeTests();
    }
}

async function runMain () {
    const ws = process.argv.includes ('--ws')
    const baseOnly = process.argv.includes ('--baseTests')
    const test = process.argv.includes ('--test') || process.argv.includes ('--tests')
    const examples = process.argv.includes ('--examples');
    const force = process.argv.includes ('--force')
    const child = process.argv.includes ('--child')
    const multiprocess = process.argv.includes ('--multiprocess') || process.argv.includes ('--multi')
    shouldTranspileTests = process.argv.includes ('--noTests') ? false : true
    if (!child && !multiprocess) {
        log.bright.green ({ force })
    }
    const transpiler = new NewTranspiler ();
    if (ws) {
        await transpiler.transpileWS (force)
    } else if (test) {
        transpiler.transpileTests ()
    } else if (multiprocess) {
        parallelizeTranspiling (exchangeIds)
    } else {
        await transpiler.transpileEverything (force, child, baseOnly, examples)
    }
}

if (isMainEntry(metaUrl)) {
    await runMain();
}
