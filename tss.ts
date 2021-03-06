// Copyright (c) Microsoft, Claus Reinke. All rights reserved.
// Licensed under the Apache License, Version 2.0. 
// See LICENSE.txt in the project root for complete license information.

///<reference path='./harness.ts'/>

// __dirname + a file to put path references in.. :-(
declare var __dirname : string;
var defaultLibs  = __dirname + "/defaultLibs.d.ts";

// TS has its own declarations for node-specific stuff, so we
// need to extend those instead of referencing node.d.ts
declare module process {
  export var stdin : any;
}

// some approximated subsets..
interface ReadlineHandlers {
  on(event: string, listener: (event:string)=>void) : ReadlineHandlers;
  close() : void;
}
interface Readline {
  createInterface(options:any) : ReadlineHandlers;
}

// bypass import, we don't want to drop out of the global module;
// use fixed readline (https://github.com/joyent/node/issues/3305),
// fixed version should be in nodejs from about v0.9.9/v0.8.19?
var readline:Readline = require("./readline");

var EOL = require("os").EOL;

/** TypeScript Services Server,
    an interactive commandline tool
    for getting info on .ts projects */
class TSS {
  public compilationSettings: TypeScript.CompilationSettings;
  public typescriptLS : Harness.TypeScriptLS;
  public ls : Services.ILanguageService;
  public rootFile : TypeScript.IResolvedFile;
  public resolutionResult : TypeScript.ReferenceResolutionResult;
  public lastError;

  constructor (public ioHost: IIO) { } // NOTE: call setup

  private fileNameToContent:TypeScript.StringHashTable<string>;

  // IReferenceResolverHost methods (from HarnessCompiler, modulo test-specific code)
  getScriptSnapshot(filename: string): TypeScript.IScriptSnapshot {
      var content = this.fileNameToContent.lookup(filename);
      if (!content) {
        content = readFile(filename).contents;
        this.fileNameToContent.add(filename,content);
      }
      var snapshot = TypeScript.ScriptSnapshot.fromString(content);

      if (!snapshot) {
          this.addDiagnostic(new TypeScript.Diagnostic(null, 0, 0, TypeScript.DiagnosticCode.Cannot_read_file_0_1, [filename, '']));
      }

      return snapshot;
  }

  resolveRelativePath(path: string, directory?: string): string {
      var unQuotedPath = TypeScript.stripStartAndEndQuotes(path);
      var normalizedPath: string;

      if (TypeScript.isRooted(unQuotedPath) || !directory) {
          normalizedPath = unQuotedPath;
      } else {
          normalizedPath = IOUtils.combine(directory, unQuotedPath);
      }

      // get the absolute path
      normalizedPath = IO.resolvePath(normalizedPath);

      // Switch to forward slashes
      normalizedPath = TypeScript.switchToForwardSlashes(normalizedPath)
                           .replace(/^(.:)/,function(_,drive){return drive.toLowerCase()});

      return normalizedPath;
  }

  fileExists(s: string):boolean {
      return IO.fileExists(s);
  }
  directoryExists(path: string): boolean {
      return IO.directoryExists(path);
  }
  getParentDirectory(path: string): string {
      return IO.dirName(path);
  }

  // IDiagnosticReporter
  addDiagnostic(diagnostic: TypeScript.Diagnostic) {
      if (diagnostic.fileName()) {
          var scriptSnapshot = this.getScriptSnapshot(diagnostic.fileName());
          if (scriptSnapshot) {
              var lineMap = new TypeScript.LineMap(scriptSnapshot.getLineStartPositions(), scriptSnapshot.getLength());
              var lineCol = { line: -1, character: -1 };
              lineMap.fillLineAndCharacterFromPosition(diagnostic.start(), lineCol);
              IO.stderr.Write(diagnostic.fileName() + "(" + (lineCol.line + 1) + "," + (lineCol.character + 1) + "): ");
          }
      }

      IO.stderr.WriteLine(diagnostic.message());  // TODO: IO vs ioHost
  }

  /** load file and dependencies, prepare language service for queries */
  public setup(file) {
    this.compilationSettings = new TypeScript.CompilationSettings();
    this.compilationSettings.gatherDiagnostics = true;
    this.compilationSettings.codeGenTarget = TypeScript.LanguageVersion.EcmaScript5;

    var useDefaultLib: boolean = true;
    /*
    TypeScript.CompilerDiagnostics.debug = true;
    TypeScript.CompilerDiagnostics.diagnosticWriter = 
      { Alert: (s: string) => { this.ioHost.printLine(s); } };
    */

    this.typescriptLS = new Harness.TypeScriptLS();
    this.fileNameToContent = new TypeScript.StringHashTable();

    // chase dependencies (references and imports)
    this.resolutionResult = TypeScript.ReferenceResolver
                              .resolve([defaultLibs,file],this,this.compilationSettings);
    // TODO: what about resolution diagnostics?
    var resolvedFiles = this.resolutionResult.resolvedFiles;

    // remember project root, resolved
    this.rootFile = resolvedFiles[resolvedFiles.length-1];

    /*
    if (useDefaultLib && !this.resolutionResult.seenNoDefaultLibTag) {
      var libraryResolvedFile: TypeScript.IResolvedFile = {
          path: this.resolveRelativePath(defaultLibs),
          referencedFiles: [],
          importedFiles: []
      };

      // Prepend default library to the resolved list
      resolvedFiles = [libraryResolvedFile].concat(resolvedFiles);
    }
    */

    // initialize languageService code units
    resolvedFiles.forEach( (code,i) => {
      // this.ioHost.printLine(i+': '+code.path);
      this.typescriptLS.addScript(code.path,this.fileNameToContent.lookup(code.path));
    });

    // Get the language service
    this.ls = this.typescriptLS.getLanguageService().languageService;
    this.ls.refresh();

  }

  /** commandline server main routine: commands in, JSON info out */
  public listen() {
    var line: number;
    var col: number;

    var rl = readline.createInterface({input:process.stdin,output:process.stdout});

    var cmd:string, pos:number, file:string, script, added:boolean, range:boolean, check:boolean
      , def, refs:Services.ReferenceEntry[], locs:Services.DefinitionInfo[], info, source:string
      , brief, member:boolean;

    var collecting = 0, on_collected_callback:()=>void, lines:string[] = [];

    rl.on('line', input => {  // most commands are one-liners
      var m:string[], commands = {};
      try {

        cmd = String(input.trim());
        cmd.match = <any>((regexp:RegExp)=>{
                      commands[regexp.source] = true;
                      return <string[]>String.prototype.match.call(cmd,regexp);
                    });

        if (collecting>0) { // multiline input, eg, source

          lines.push(input)
          collecting--;

          if (collecting===0) {
            on_collected_callback();
          }

        } else if (m = cmd.match(/^type (\d+) (\d+) (.*)$/)) {

          line   = parseInt(m[1]);
          col    = parseInt(m[2]);
          file   = this.resolveRelativePath(m[3]);

          pos     = this.typescriptLS.lineColToPosition(file,line,col);

          info = (this.ls.getTypeAtPosition(file, pos)||{});
          info.type = (info.memberName||"").toString();

          this.ioHost.printLine(JSON.stringify(info).trim());

        } else if (m = cmd.match(/^definition (\d+) (\d+) (.*)$/)) {

          line = parseInt(m[1]);
          col  = parseInt(m[2]);
          file = this.resolveRelativePath(m[3]);

          pos  = this.typescriptLS.lineColToPosition(file,line,col);
          locs = this.ls.getDefinitionAtPosition(file, pos); // NOTE: multiple definitions

          info = locs.map( def => ({
            def  : def,
            file : def && def.fileName,
            min  : def && this.typescriptLS.positionToLineCol(def.fileName,def.minChar),
            lim  : def && this.typescriptLS.positionToLineCol(def.fileName,def.limChar)
          }));

          // TODO: what about multiple definitions?
          this.ioHost.printLine(JSON.stringify(info[0]||null).trim());

        } else if (m = cmd.match(/^(references|occurrences|implementors) (\d+) (\d+) (.*)$/)) {

          line = parseInt(m[2]);
          col  = parseInt(m[3]);
          file = this.resolveRelativePath(m[4]);

          pos  = this.typescriptLS.lineColToPosition(file,line,col);
          switch (m[1]) {
            case "references":
              refs = this.ls.getReferencesAtPosition(file, pos);
              break;
            case "occurrences":
              refs = this.ls.getOccurrencesAtPosition(file, pos);
              break;
            case "implementors":
              refs = this.ls.getImplementorsAtPosition(file, pos);
              break;
            default:
              throw "cannot happen";
          }

          info = refs.map( ref => ({
            ref  : ref,
            file : ref && ref.fileName,
            min  : ref && this.typescriptLS.positionToLineCol(ref.fileName,ref.minChar),
            lim  : ref && this.typescriptLS.positionToLineCol(ref.fileName,ref.limChar)
          }));

          this.ioHost.printLine(JSON.stringify(info).trim());

        } else if (m = cmd.match(/^structure (.*)$/)) {

          file = this.resolveRelativePath(m[1]);

          locs = this.ls.getScriptLexicalStructure(file);

          info = locs.map( loc => ({
            loc  : loc,
            file : loc && loc.fileName,
            min  : loc && this.typescriptLS.positionToLineCol(loc.fileName,loc.minChar),
            lim  : loc && this.typescriptLS.positionToLineCol(loc.fileName,loc.limChar)
          }));

          this.ioHost.printLine(JSON.stringify(info).trim());

        } else if (m = cmd.match(/^completions(-brief)? (true|false) (\d+) (\d+) (.*)$/)) {

          brief  = m[1];
          member = m[2]==='true';
          line   = parseInt(m[3]);
          col    = parseInt(m[4]);
          file   = this.resolveRelativePath(m[5]);

          pos     = this.typescriptLS.lineColToPosition(file,line,col);

          info = this.ls.getCompletionsAtPosition(file, pos, member);

          if (info) {
            // fill in completion entry details, unless briefness requested
            !brief && (info.entries = info.entries.map( e =>
                                        this.ls.getCompletionEntryDetails(file,pos,e.name) ));

            (()=>{ // filter entries by prefix, determined by pos
              var languageVersion = this.compilationSettings.codeGenTarget;
              var source   = this.typescriptLS.getScriptInfo(file).content;
              var startPos = pos;
              var idPart   = p => /[0-9a-zA-Z_$]/.test(source[p])
                               || TypeScript.Unicode.isIdentifierPart(source.charCodeAt(p),languageVersion);
              var idStart  = p => /[a-zA-Z_$]/.test(source[p])
                               || TypeScript.Unicode.isIdentifierStart(source.charCodeAt(p),languageVersion);
              while ((--startPos>=0) && idPart(startPos) );
              if ((++startPos < pos) && idStart(startPos)) {
                var prefix = source.slice(startPos,pos);
                info["prefix"] = prefix;
                var len    = prefix.length;
                info.entries = info.entries.filter( e => e.name.substr(0,len)===prefix );
              }
            })();
          }

          this.ioHost.printLine(JSON.stringify(info).trim());

        } else if (m = cmd.match(/^info (\d+) (\d+) (.*)$/)) { // mostly for debugging

          line = parseInt(m[1]);
          col  = parseInt(m[2]);
          file = this.resolveRelativePath(m[3]);

          pos  = this.typescriptLS.lineColToPosition(file,line,col);

          def  = this.ls.getDefinitionAtPosition(file, pos)[0];

          // source       = this.ls.getScriptSyntaxAST(file).getSourceText();
          // var span     = this.ls.getNameOrDottedNameSpan(file,pos,-1);
          // var spanText = span && source.getText(span.minChar,span.limChar);
          // member       = span && spanText.indexOf('.') !== -1;

          var typeInfo = this.ls.getTypeAtPosition(file, pos);
          var type     = typeInfo.memberName;
          var symbol   = typeInfo.fullSymbolName;

          info = { // all together now..
            pos         : pos,
            linecol     : this.typescriptLS.positionToLineCol(file,pos),

            symbol      : symbol,
            type        : (type||"").toString(),

            def         : def,
            file        : def && def.fileName,
            min         : def && this.typescriptLS.positionToLineCol(def.fileName,def.minChar),
            lim         : def && this.typescriptLS.positionToLineCol(def.fileName,def.limChar),

            // signature: this.ls.getSignatureAtPosition(file, pos), // ??

            // completions : this.ls.getCompletionsAtPosition(file, pos, member),

            // spanText : spanText,
            // member   : member,
          };

          this.ioHost.printLine(JSON.stringify(info).trim());

        } else if (m = cmd.match(/^update( nocheck)? (\d+)( (\d+)-(\d+))? (.*)$/)) { // send non-saved source

          file       = this.resolveRelativePath(m[6]);
          script     = this.typescriptLS.getScriptInfo(file);
          added      = script==null;
          range      = !!m[3]
          check      = !m[1]

          if (!added || !range) {
            collecting = parseInt(m[2]);
            on_collected_callback = () => {

              if (!range) {
                this.typescriptLS.updateScript(file,lines.join(EOL));
              } else {
                var startLine = parseInt(m[4]);
                var endLine   = parseInt(m[5]);
                var maxLines  = script.lineMap.lineCount();
                var startPos  = startLine<=maxLines
                              ? (startLine<1 ? 0 : this.typescriptLS.lineColToPosition(file,startLine,1))
                              : script.content.length;
                var endPos    = endLine<maxLines
                              ? (endLine<1 ? 0 : this.typescriptLS.lineColToPosition(file,endLine+1,1)-1)
                              : script.content.length;

                this.typescriptLS.editScript(file, startPos, endPos, lines.join(EOL));
              }
              var syn:number,sem:number;
              if (check) {
                syn = this.ls.getSyntacticDiagnostics(file).length;
                sem = this.ls.getSemanticDiagnostics(file).length;
              }
              on_collected_callback = undefined;
              lines = [];

              this.ioHost.printLine((added ? '"added ' : '"updated ')
                                    +(range ? 'lines'+m[3]+' in ' : '')
                                    +file+(check ? ', ('+syn+'/'+sem+') errors' : '')+'"');
            };
          } else {
            this.ioHost.printLine('"cannot update line range in new file"');
          }

        } else if (m = cmd.match(/^showErrors$/)) { // get processing errors

          info = [].concat(this.resolutionResult.diagnostics.map(d=>{d["phase"]="Resolution";return d}),
                           this.typescriptLS.getErrors())
                   .map( d => {
                           var file = d.fileName();
                           var lc   = this.typescriptLS.positionToLineCol(file,d.start());
                           var len  = this.typescriptLS.getScriptInfo(file).content.length;
                           var end  = Math.min(len,d.start()+d.length()); // NOTE: clamped to end of file (#11)
                           var lc2  = this.typescriptLS.positionToLineCol(file,end);
                           var diagInfo = TypeScript.getDiagnosticInfoFromKey(d.diagnosticKey());
                           var category = TypeScript.DiagnosticCategory[diagInfo.category];
                           return {
                            file: file,
                            start: {line: lc.line, character: lc.character},
                            end: {line: lc2.line, character: lc2.character},
                            text: /* file+"("+lc.line+"/"+lc.character+"): "+ */ d.message(),
                            phase: d.phase,
                            category: category
                            // ,diagnostic: d
                           };
                         }
                       );

          this.ioHost.printLine(JSON.stringify(info).trim());

        } else if (m = cmd.match(/^files$/)) { // list files in project

          info = this.typescriptLS.getScriptFileNames(); // TODO: shim/JSON vs real-ls/array

          this.ioHost.printLine(info.trim());

        } else if (m = cmd.match(/^lastError(Dump)?$/)) { // debugging only

          if (this.lastError)
            if (m[1]) // commandline use
              this.ioHost.printLine(JSON.parse(this.lastError).stack);
            else
              this.ioHost.printLine(this.lastError);
          else
            this.ioHost.printLine('"no last error"');

        } else if (m = cmd.match(/^dump (\S+) (.*)$/)) { // debugging only

          var dump = m[1];
          file     = this.resolveRelativePath(m[2]);

          source         = this.typescriptLS.getScriptInfo(file).content;
          if (dump==="-") { // to console
            this.ioHost.printLine('dumping '+file);
            this.ioHost.printLine(source);
          } else { // to file
            this.ioHost.writeFile(dump,source,false);

            this.ioHost.printLine('"dumped '+file+' to '+dump+'"');
          }

        } else if (m = cmd.match(/^reload$/)) { // reload current project

          this.setup(this.rootFile.path);
          this.ioHost.printLine('"reloaded '+this.rootFile.path+', TSS listening.."');

        } else if (m = cmd.match(/^quit$/)) {

          rl.close();

        } else if (m = cmd.match(/^help$/)) {

          this.ioHost.printLine(Object.keys(commands).join(EOL));

        } else {

          this.ioHost.printLine('"TSS command syntax error: '+cmd+'"');

        }

      } catch(e) {

          this.lastError = (JSON.stringify({msg:e.toString(),stack:e.stack})).trim();
          this.ioHost.printLine('"TSS command processing error: '+e+'"');

      }

    }).on('close', () => {

          this.ioHost.printLine('"TSS closing"');

    });

    this.ioHost.printLine('"loaded '+this.rootFile.path+', TSS listening.."');

  }
}

if (IO.arguments.indexOf("--version")!==-1) {
  console.log(require("../package.json").version);
  process.exit(0);
}

var tss = new TSS(IO);
tss.setup(IO.arguments[0]);
tss.listen();
