import 'isomorphic-fetch';
import * as e6p from "es6-promise";
(e6p as any).polyfill();
export interface SASjsRequest {
  serviceLink: string;
  timestamp: Date;
  sourceCode: string;
  generatedCode: string;
  logFile: string;
  SASWORK: any;
}

export interface SASjsWatingRequest {
  requestPromise: {
    promise: any;
    resolve: any;
    reject: any;
  };
  programName: string;
  data: any;
  params?: any;
}

export class SASjsConfig {
  serverUrl: string = "";
  pathSAS9: string = "";
  pathSASViya: string = "";
  appLoc: string = "";
  serverType: string = "";
  debug: boolean = true;
}

const defaultConfig: SASjsConfig = {
  serverUrl: "",
  pathSAS9: "/SASStoredProcess/do",
  pathSASViya: "/SASJobExecution",
  appLoc: "/Public/seedapp",
  serverType: "SASVIYA",
  debug: true
};

/**
 * SASjs is a JavaScript adapter for SAS.
 *
 */
export default class SASjs {
  private sasjsConfig = new SASjsConfig();
  private serverUrl: string = "";
  private jobsPath: string = "";
  private appLoc: string = "";
  private logoutUrl: string = "";
  private loginUrl: string = "";
  private _csrf: string | null = null;
  private retryCount: number = 0;
  private retryLimit: number = 5;
  private sasjsRequests: SASjsRequest[] = [];
  private sasjsWaitingRequests: SASjsWatingRequest[] = [];
  private userName: string = "";

  constructor(config?: any) {
    this.sasjsConfig = {
      ...defaultConfig,
      ...config
    };
    this.setupConfiguration();
  }

  /**
   * Returns the current SASjs configuration.
   *
   */
  public getSasjsConfig() {
    return this.sasjsConfig;
  }

  /**
   * Returns the username of the user currently logged in.
   *
   */
  public getUserName() {
    return this.userName;
  }

  /**
   * Returns the _csrf token of the current session.
   *
   */
  public getCsrf() {
    return this._csrf;
  }

  /**
   * Sets the SASjs configuration.
   * @param config - SASjsConfig indicating SASjs Configuration
   */
  public setSASjsConfig(config: SASjsConfig) {
    this.sasjsConfig = {
      ...this.sasjsConfig,
      ...config
    };
    this.setupConfiguration();
  }

  /**
   * Sets the debug state.
   * @param value - Boolean indicating debug state
   */
  public setDebugState(value: boolean) {
    this.sasjsConfig.debug = value;
  }

  /**
   * Checks whether a session is active, or login is required
   * @returns a promise which resolves with an object containing two values - a boolean `isLoggedIn`, and a string `userName`
   */
  public async checkSession() {
    const loginResponse = await fetch(this.loginUrl);
    const responseText = await loginResponse.text();
    const isLoginRequired = this.isLogInRequired(responseText);

    return Promise.resolve({
      isLoggedIn: !isLoginRequired,
      userName: this.userName
    });
  }

  /**
   * Logs into the SAS server with the supplied credentials
   * @param username - a string representing the username
   * @param password - a string representing the password
   */
  public async logIn(username: string, password: string) {
    const loginParams: any = {
      _service: "default",
      username,
      password
    };

    this.userName = loginParams.username;

    const { isLoggedIn } = await this.checkSession();
    if (isLoggedIn) {
      this.resendWaitingRequests();

      return Promise.resolve({
        isLoggedIn,
        userName: this.userName
      });
    }

    const loginForm = await this.getLoginForm();

    for (const key in loginForm) {
      loginParams[key] = loginForm[key];
    }
    const loginParamsStr = serialize(loginParams);

    return fetch(this.loginUrl, {
      method: "post",
      credentials: "include",
      referrerPolicy: "same-origin",
      body: loginParamsStr,
      headers: new Headers({
        "Content-Type": "application/x-www-form-urlencoded"
      })
    })
      .then(response => response.text())
      .then(async responseText => {
        let authFormRes: any;
        let isLoggedIn;

        if (this.isAuthorizeFormRequired(responseText)) {
          authFormRes = await this.parseAndSubmitAuthorizeForm(responseText);
          isLoggedIn = authFormRes.includes('Authentication success, retry original request');
        } else {
          isLoggedIn = this.isLogInSuccess(responseText);
          if (!isLoggedIn) isLoggedIn = !this.isLogInRequired(responseText);
        }

        if (isLoggedIn) {
          this.resendWaitingRequests();
        }

        return {
          isLoggedIn: isLoggedIn,
          userName: this.userName
        };
      })
      .catch(e => Promise.reject(e));
  }

  /**
   * Logs out of the configured SAS server
   */
  public logOut() {
    return new Promise((resolve, reject) => {
      const logOutURL = `${this.serverUrl}${this.logoutUrl}`;
      fetch(logOutURL)
        .then(() => {
          resolve(true);
        })
        .catch((err: Error) => reject(err));
    });
  }

  /**
   * Makes a request to the program specified.
   * @param programName - a string representing the SAS program name
   * @param data - an object containing the data to be posted
   * @param params - an optional object with any additional parameters
   */
  public async request(programName: string, data: any, params?: any, loginRequiredCallback?: any) {
    const program = this.appLoc
      ? this.appLoc.replace(/\/?$/, "/") + programName.replace(/^\//, "")
      : programName;
    const apiUrl = `${this.serverUrl}${this.jobsPath}/?_program=${program}`;

    const inputParams = params ? params : {};
    const requestParams = {
      ...inputParams,
      ...this.getRequestParams()
    };

    const self = this;

    const formData = new FormData();

    let logInRequired = false;
    let isError = false;
    let errorMsg = "";

    if (data) {
      if (this.sasjsConfig.serverType === "SAS9") {
        // file upload approach
        for (const tableName in data) {
          if (isError) {
            return;
          }
          const name = tableName;
          const csv = convertToCSV(data[tableName]);
          if (csv === "ERROR: LARGE STRING LENGTH") {
            isError = true;
            errorMsg =
              "The max length of a string value in SASjs is 32765 characters.";
          }

          formData.append(
            name,
            new Blob([csv], { type: "application/csv" }),
            `${name}.csv`
          );
        }
      } else {
        // param based approach
        const sasjsTables = [];
        let tableCounter = 0;
        for (const tableName in data) {
          if (isError) {
            return;
          }
          tableCounter++;
          sasjsTables.push(tableName);
          const csv = convertToCSV(data[tableName]);
          if (csv === "ERROR: LARGE STRING LENGTH") {
            isError = true;
            errorMsg =
              "The max length of a string value in SASjs is 32765 characters.";
          }
          // if csv has length more then 16k, send in chunks
          if (csv.length > 16000) {
            let csvChunks = splitChunks(csv);
            // append chunks to form data with same key
            csvChunks.map(chunk => {
              formData.append(`sasjs${tableCounter}data`, chunk);
            });
          } else {
            requestParams[`sasjs${tableCounter}data`] = csv;
          }
        }
        requestParams["sasjs_tables"] = sasjsTables.join(" ");
      }
    }

    for (const key in requestParams) {
      if (requestParams.hasOwnProperty(key)) {
        formData.append(key, requestParams[key]);
      }
    }

    let sasjsWaitingRequest: SASjsWatingRequest = {
      requestPromise: {
        promise: null,
        resolve: null,
        reject: null
      },
      programName: programName,
      data: data,
      params: params
    };

    let isRedirected = false;

    sasjsWaitingRequest.requestPromise.promise = new Promise(
       (resolve, reject) => {
        if (isError) {
          reject({ MESSAGE: errorMsg });
        }
         fetch(apiUrl, {
          method: "POST",
          body: formData,
          referrerPolicy: "same-origin"
        })
          .then(async response => {
            if (!response.ok) {
              if (response.status === 403) {
                const tokenHeader = response.headers.get("X-CSRF-HEADER");

                if (tokenHeader) {
                  const token = response.headers.get(tokenHeader);

                  this._csrf = token;
                }
              }
            }

            if (response.redirected && this.sasjsConfig.serverType === "SAS9") {
              isRedirected = true;
            }

            return response.text();
          })
          .then(responseText => {
            if (
              (this.needsRetry(responseText) || isRedirected) &&
              !this.isLogInRequired(responseText)
            ) {
              if (this.retryCount < this.retryLimit) {
                this.retryCount++;
                this.request(programName, data, params).then(
                  (res: any) => resolve(res),
                  (err: any) => reject(err)
                );
              } else {
                this.retryCount = 0;
                reject(responseText);
              }
            } else {
              this.retryCount = 0;
              this.parseLogFromResponse(responseText, program);

              if (self.isLogInRequired(responseText)) {
                if (loginRequiredCallback) loginRequiredCallback(true);
                logInRequired = true;
                sasjsWaitingRequest.requestPromise.resolve = resolve;
                sasjsWaitingRequest.requestPromise.reject = reject;
                this.sasjsWaitingRequests.push(sasjsWaitingRequest);
              } else {
                if (
                  this.sasjsConfig.serverType === "SAS9" &&
                  this.sasjsConfig.debug
                ) {
                  this.updateUsername(responseText);
                  const jsonResponseText = this.parseSAS9Response(responseText);

                  if (jsonResponseText !== "") {
                    resolve(JSON.parse(jsonResponseText));
                  } else {
                    reject({
                      MESSAGE: this.parseSAS9ErrorResponse(responseText)
                    });
                  }
                } else if (
                  this.sasjsConfig.serverType === "SASVIYA" &&
                  this.sasjsConfig.debug
                ) {
                  try {
                    this.parseSASVIYADebugResponse(responseText).then((resText: any) => {
                      this.updateUsername(resText);
                        try {
                          resolve(JSON.parse(resText));
                        } catch (e) {
                          reject({ MESSAGE: resText });
                        }
                    }, (err: any) => {reject({ MESSAGE: err })});
                  } catch (e) {
                    reject({ MESSAGE: responseText });
                  }
                } else {
                  this.updateUsername(responseText);
                  try {
                    let parsedJson = JSON.parse(responseText);
                    resolve(parsedJson);
                  } catch (e) {
                    reject({ MESSAGE: responseText });
                  }
                }
              }
            }
          })
          .catch((e: Error) => {
            reject(e);
          });
      }
    );

    return sasjsWaitingRequest.requestPromise.promise;
  }

  private async resendWaitingRequests() {
    for (let sasjsWaitingRequest of this.sasjsWaitingRequests) {
      this.request(
        sasjsWaitingRequest.programName,
        sasjsWaitingRequest.data,
        sasjsWaitingRequest.params
      ).then(
        (res: any) => {
          sasjsWaitingRequest.requestPromise.resolve(res);
        },
        (err: any) => {
          sasjsWaitingRequest.requestPromise.reject(err);
        }
      );
    }

    this.sasjsWaitingRequests = [];
  }

  private needsRetry(responseText: string): boolean {
    return (
      (responseText.includes('"errorCode":403') &&
        responseText.includes("_csrf") &&
        responseText.includes("X-CSRF-TOKEN")) ||
        (responseText.includes('"status":403') &&
        responseText.includes('"error":"Forbidden"')) ||
      (responseText.includes('"status":449') &&
        responseText.includes("Authentication success, retry original request"))
    );
  }

  private getRequestParams(): any {
    const requestParams: any = {};

    if (this._csrf) {
      requestParams["_csrf"] = this._csrf;
    }

    if (this.sasjsConfig.debug) {
      requestParams["_omittextlog"] = "false";
      requestParams["_omitsessionresults"] = "false";

      requestParams["_debug"] = 131;
    }

    return requestParams;
  }

  private updateUsername(response: any) {
    try {
      const responseJson = JSON.parse(response);
      if (this.sasjsConfig.serverType === "SAS9") {
        this.userName = responseJson["_METAUSER"];
      } else {
        this.userName = responseJson["SYSUSERID"];
      }
    } catch (e) {
      this.userName = "";
    }
  }

  private parseSASVIYADebugResponse(response: string) {
    return new Promise((resolve, reject) => {
      const iframe_start = response.split(
        '<iframe style="width: 99%; height: 500px" src="'
      )[1];
      const json_url = iframe_start
        ? iframe_start.split('"></iframe>')[0]
        : null;

      if (json_url) {
        fetch(this.serverUrl + json_url)
          .then(res => res.text())
          .then(resText => {
            resolve(resText);
          });
      } else {
        reject("No debug info in response");
      }
    });
  }

  private parseSAS9Response(response: string) {
    let sas9Response = "";

    if (response.includes(">>weboutBEGIN<<")) {
      try {
        sas9Response = response
          .split(">>weboutBEGIN<<")[1]
          .split(">>weboutEND<<")[0];
      } catch (e) {
        sas9Response = "";
        console.error(e);
      }
    }

    return sas9Response;
  }

  private parseSAS9ErrorResponse(response: string) {
    let logLines = response.split("\n");
    let parsedLines: string[] = [];
    let firstErrorLineIndex: number = -1;

    logLines.map((line: string, index: number) => {
      if (
        line.toLowerCase().includes("error") &&
        !line.toLowerCase().includes("this request completed with errors.") &&
        firstErrorLineIndex === -1
      ) {
        firstErrorLineIndex = index;
      }
    });

    for (let i = firstErrorLineIndex - 10; i <= firstErrorLineIndex + 10; i++) {
      parsedLines.push(logLines[i]);
    }

    return parsedLines.join(", ");
  }

  private parseLogFromResponse(response: any, program: string) {
    if (this.sasjsConfig.serverType === "SAS9") {
      this.appendSasjsRequest(response, program, null);
    } else {
      if (!this.sasjsConfig.debug) {
        this.appendSasjsRequest(null, program, null);
      } else {
        this.appendSasjsRequest(response, program, null);
      }
    }
  }

  private fetchLogFileContent(logLink: string) {
    return new Promise((resolve, reject) => {
      fetch(logLink, {
        method: "GET"
      })
        .then((response: any) => response.text())
        .then((response: any) => resolve(response))
        .catch((err: Error) => reject(err));
    });
  }

  private async appendSasjsRequest(response: any, program: string, pgmData: any) {
    let sourceCode = "";
    let generatedCode = "";
    let sasWork = null;

    if (response) {
      sourceCode = this.parseSourceCode(response);
      generatedCode = this.parseGeneratedCode(response);
      sasWork = await this.parseSasWork(response);
    }

    this.sasjsRequests.push({
      logFile: response,
      serviceLink: program,
      timestamp: new Date(),
      sourceCode,
      generatedCode,
      SASWORK: sasWork
    });

    if (this.sasjsRequests.length > 20) {
      this.sasjsRequests.splice(0, 1);
    }
  }

  private async parseSasWork(response: any) {
    if (this.sasjsConfig.debug) {
      let jsonResponse;

      if (this.sasjsConfig.serverType === "SAS9") {
        try {
          jsonResponse = JSON.parse(this.parseSAS9Response(response));
        } catch (e) {}
      } else {
        await this.parseSASVIYADebugResponse(response).then((resText: any) => {
          try {
            jsonResponse = JSON.parse(resText);
          } catch (e) {}
        }, (err: any) =>{
          console.log(err);
        });
      }

      if (jsonResponse) {
        return jsonResponse.WORK;
      }
    }
    return null;
  }

  private parseSourceCode(log: string) {
    const isSourceCodeLine = (line: string) =>
      line
        .trim()
        .substring(0, 10)
        .trimStart()
        .match(/^\d/);
    const logLines = log.split("\n").filter(isSourceCodeLine);
    return logLines.join("\r\n");
  }

  private parseGeneratedCode(log: string) {
    let startsWith = "MPRINT";
    const isGeneratedCodeLine = (line: string) =>
      line.trim().startsWith(startsWith);
    const logLines = log.split("\n").filter(isGeneratedCodeLine);
    return logLines.join("\r\n");
  }

  public getSasRequests() {
    const sortedRequests = this.sasjsRequests.sort(compareTimestamps);
    return sortedRequests;
  }

  private setupConfiguration() {
    if (this.sasjsConfig.serverUrl === undefined || this.sasjsConfig.serverUrl === "") {
      let url = `${location.protocol}//${location.hostname}`;
      if (location.port) {
        url = `${url}:${location.port}`;
      }
      this.sasjsConfig.serverUrl = url;
    }

    if (this.sasjsConfig.serverUrl.slice(-1) === "/") {
      this.sasjsConfig.serverUrl = this.sasjsConfig.serverUrl.slice(0, -1);
    }

    this.serverUrl = this.sasjsConfig.serverUrl;
    this.jobsPath =
      this.sasjsConfig.serverType === "SASVIYA"
        ? this.sasjsConfig.pathSASViya
        : this.sasjsConfig.pathSAS9;
    this.appLoc = this.sasjsConfig.appLoc;
    this.loginUrl = `${this.serverUrl}/SASLogon/login`;
    this.logoutUrl =
      this.sasjsConfig.serverType === "SAS9"
        ? "/SASLogon/logout?"
        : "/SASLogon/logout.do?";
  }

  private setLoginUrl = (matches: RegExpExecArray) => {
    let parsedURL = matches[1].replace(/\?.*/, "");
    if (parsedURL[0] === "/") {
      parsedURL = parsedURL.substr(1);

      const tempLoginLink = this.serverUrl
        ? `${this.serverUrl}/${parsedURL}`
        : `${parsedURL}`;

      let loginUrl = tempLoginLink;
      if (this.sasjsConfig.serverType === "SAS9") {
        loginUrl = this.getSas9LoginUrl(tempLoginLink);
      }

      this.loginUrl = loginUrl;
    }
  };

  private getSas9LoginUrl = (loginUrl: string) => {
    const tempLoginLinkArray = loginUrl.split(".");
    const doIndex = tempLoginLinkArray.indexOf("do");

    if (doIndex > -1) {
      tempLoginLinkArray.splice(doIndex, 1);
    }

    return tempLoginLinkArray.join(".");
  };

  public isAuthorizeFormRequired(response: any) {
    return /<form.+action="(.*Logon\/oauth\/authorize[^"]*).*>/gm.test(
      response
    );
  }

  public async parseAndSubmitAuthorizeForm(response: any) {
    let authUrl: string | null = null;
    let params: any = {};

    let responseBody = response.split("<body>")[1].split("</body>")[0];
    let bodyElement = document.createElement("div");
    bodyElement.innerHTML = responseBody;

    let form = bodyElement.querySelector("#application_authorization");
    authUrl = form
      ? this.sasjsConfig.serverUrl + form.getAttribute("action")
      : null;

    let inputs: any = form!.querySelectorAll("input");

    for (let input of inputs) {
      if (input.name === "user_oauth_approval") {
        input.value = "true";
      }

      params[input.name] = input.value;
    }

    let formData = new FormData();

    for (const key in params) {
      if (params.hasOwnProperty(key)) {
        formData.append(key, params[key]);
      }
    }

    return new Promise((resolve, reject) => {
      if (authUrl) {
        fetch(authUrl, {
          method: "POST",
          credentials: "include",
          body: formData,
          referrerPolicy: "same-origin"
        })
          .then(res => res.text())
          .then(res => {
            resolve(res);
          });
      } else {
        reject("Auth form url is null");
      }
    });
  }

  public getAuthCode(client_id: string) {
    return new Promise((resolve, reject) => {
      let authUrl = this.sasjsConfig.serverUrl + `/SASLogon/oauth/authorize?client_id=${client_id}&response_type=code`;
    
      fetch(authUrl, {
        referrerPolicy: 'same-origin',
        credentials: 'include'
      })
      .then(response => response.text())
      .then(response => {
        let authcode: string = "";
        let responseBody = response.split("<body>")[1].split("</body>")[0];
        let bodyElement: any = document.createElement("div");
        bodyElement.innerHTML = responseBody;

        if (bodyElement) {
          authcode = bodyElement.querySelector('.infobox h4').innerText;
        }

        localStorage.setItem('auth_code', authcode);
        resolve(authcode);
      });
    });
  }

  public getAccessToken(client_id: string, client_secret: string, auth_code: string) {
    return new Promise((resolve, reject) => {
      let url = this.sasjsConfig.serverUrl + '/SASLogon/oauth/token';
      let headers = {
        'Authorization': 'Basic ' + btoa(client_id + ":" + client_secret)
      }
  
      let formData = new FormData();
      formData.append('grant_type', 'authorization_code');
      formData.append('code', auth_code);
  
      fetch(url, {
        method: 'POST',
        credentials: "include",
        headers: headers,
        body: formData,
        referrerPolicy: "same-origin"
      })
      .then(res => res.text())
      .then(res => {
        localStorage.setItem('client_id', client_id);
        localStorage.setItem('client_secret', client_secret);
        localStorage.setItem('auth_data', res);
        resolve(JSON.parse(res));
      });
    });
  }

  public deleteClient(client_id: string) {
    return new Promise((resolve, reject) => {
      let access_token = "";
      let auth_data: any = localStorage.getItem('auth_data') || "";
      auth_data = JSON.parse(auth_data);
      access_token = auth_data.access_token;

      let url = this.sasjsConfig.serverUrl + `/oauth/clients/${client_id}`;

      let headers = {
        'Authorization': access_token
      }

      fetch(url, {
        method: 'DELETE',
        credentials: 'include',
        headers: headers
      })
      .then(res => res.text())
      .then(res => {
        resolve(res);
      })
    });
  }

  private async getLoginForm() {
    const pattern: RegExp = /<form.+action="(.*Logon[^"]*).*>/;
    const response = await fetch(this.loginUrl).then(r => r.text());
    const matches = pattern.exec(response);
    const formInputs: any = {};
    if (matches && matches.length) {
      this.setLoginUrl(matches);
      const inputs = response.match(/<input.*"hidden"[^>]*>/g);
      if (inputs) {
        inputs.forEach((inputStr: string) => {
          const valueMatch = inputStr.match(/name="([^"]*)"\svalue="([^"]*)/);
          if (valueMatch && valueMatch.length) {
            formInputs[valueMatch[1]] = valueMatch[2];
          }
        });
      }
    }
    return Object.keys(formInputs).length ? formInputs : null;
  }
    
  private isLogInSuccess = (response: any) => /You have signed in/gm.test(response);

  private isLogInRequired = (response: any) => {
    const pattern: RegExp = /<form.+action="(.*Logon[^"]*).*>/gm;
    const matches = pattern.test(response);
    return matches;
  };
}

const compareTimestamps = (a: SASjsRequest, b: SASjsRequest) => {
  return b.timestamp.getTime() - a.timestamp.getTime();
};

function splitChunks(string: string) {
  let size = 16000;

  var numChunks = Math.ceil(string.length / size),
    chunks = new Array(numChunks);

  for (var i = 0, o = 0; i < numChunks; ++i, o += size) {
    chunks[i] = string.substr(o, size);
  }

  return chunks;
}

function getByteSize(str: string) {
  var s = str.length;
  for (var i = str.length - 1; i >= 0; i--) {
    var code = str.charCodeAt(i);
    if (code > 0x7f && code <= 0x7ff) s++;
    else if (code > 0x7ff && code <= 0xffff) s += 2;
    if (code >= 0xdc00 && code <= 0xdfff) i--; //trail surrogate
  }
  return s;
}

function serialize(obj: any) {
  const str: any[] = [];
  for (const p in obj) {
    if (obj.hasOwnProperty(p)) {
      if (obj[p] instanceof Array) {
        for (let i = 0, n = obj[p].length; i < n; i++) {
          str.push(encodeURIComponent(p) + "=" + encodeURIComponent(obj[p][i]));
        }
      } else {
        str.push(encodeURIComponent(p) + "=" + encodeURIComponent(obj[p]));
      }
    }
  }
  return str.join("&");
}

function convertToCSV(data: any) {
  const replacer = (key: any, value: any) => (value === null ? "" : value);
  const headerFields = Object.keys(data[0]);
  let csvTest;
  let invalidString = false;
  const headers = headerFields.map(field => {
    let firstFoundType: string | null = null;
    let hasMixedTypes: boolean = false;
    let rowNumError: number = -1;

    const longestValueForField = data
      .map((row: any, index: number) => {
        if (row[field] || row[field] === "") {
          if (firstFoundType) {
            let currentFieldType =
              row[field] === "" || typeof row[field] === "string"
                ? "chars"
                : "number";

            if (!hasMixedTypes) {
              hasMixedTypes = currentFieldType !== firstFoundType;
              rowNumError = hasMixedTypes ? index + 1 : -1;
            }
          } else {
            if (row[field] === "") {
              firstFoundType = "chars";
            } else {
              firstFoundType =
                typeof row[field] === "string" ? "chars" : "number";
            }
          }

          let byteSize;

          if (typeof row[field] === "string") {
            let doubleQuotesFound = row[field]
              .split("")
              .filter((char: any) => char === '"');

            byteSize = getByteSize(row[field]);

            if (doubleQuotesFound.length > 0) {
              byteSize += doubleQuotesFound.length;
            }
          }

          return byteSize;
        }
      })
      .sort((a: number, b: number) => b - a)[0];
    if (longestValueForField && longestValueForField > 32765) {
      invalidString = true;
    }
    if (hasMixedTypes) {
      console.error(
        `Row (${rowNumError}), Column (${field}) has mixed types: ERROR`
      );
    }

    return `${field}:${firstFoundType === "chars" ? "$" : ""}${
      longestValueForField
        ? longestValueForField
        : firstFoundType === "chars"
        ? "1"
        : "best"
    }.`;
  });

  if (invalidString) {
    return "ERROR: LARGE STRING LENGTH";
  }
  csvTest = data.map((row: any) => {
    const fields = Object.keys(row).map((fieldName, index) => {
      let value;
      let containsSpecialChar = false;
      const currentCell = row[fieldName];

      if (JSON.stringify(currentCell).search(/(\\t|\\n|\\r)/gm) > -1) {
        value = currentCell.toString();
        containsSpecialChar = true;
      } else {
        value = JSON.stringify(currentCell, replacer);
      }

      value = value.replace(/\\\\/gm, "\\");

      if (containsSpecialChar) {
        if (value.includes(",") || value.includes('"')) {
          value = '"' + value + '"';
        }
      } else {
        if (
          !value.includes(",") &&
          value.includes('"') &&
          !value.includes('\\"')
        ) {
          value = value.substring(1, value.length - 1);
        }

        value = value.replace(/\\"/gm, '""');
      }

      value = value.replace(/\r\n/gm, "\n");

      if (value === "" && headers[index].includes("best")) {
        value = ".";
      }

      return value;
    });
    return fields.join(",");
  });

  let finalCSV =
    headers.join(",").replace(/,/g, " ") + "\r\n" + csvTest.join("\r\n");

  return finalCSV;
}
