import _ from "lodash";
import Jexl from 'jexl';
import { get } from '@shell/utils/object';

/**
 * Return list of variables to filter chart questions
 */
export const ignoreVariables = (cluster, data) => {
  const pspChartMap = {
    epinio: 'global.rbac.pspEnabled',
    longhorn: 'enablePSP',
    'rancher-alerting-drivers': 'global.cattle.psp.enabled',
    neuvector: 'global.cattle.psp.enabled',
    'prometheus-federator': 'global.rbac.pspEnabled',
  };
  const path = pspChartMap[data.chart.name];

  if (path) {
    const clusterVersion = cluster?.kubernetesVersion || '';
    const version = clusterVersion.match(/\d+/g);
    const isRequiredVersion = version?.length ? +version[0] === 1 && +version[1] < 25 : false;

    // Provide path as question variable to be ignored
    if (!isRequiredVersion) {
      return [path];
    }
  }

  return [];
}

function evaluate(values, question, allQuestions) {
  if (!question.show_if) {
    return true;
  }
  const and = question.show_if.split('&&');
  const or = question.show_if.split('||');

  let result;

  if (get(or, 'length') > 1) {
    result = or.some((showIf) => calExpression(values, showIf, allQuestions));
  } else {
    result = and.every((showIf) => calExpression(values, showIf, allQuestions));
  }

  return result;
}

function getVariables(showIf, operator) {
  if (showIf.includes(operator)) {
    const array = showIf.split(operator);

    if (array.length === 2) {
      return {
        left: array[0],
        right: array[1]
      };
    } else {
      return null;
    }
  }

  return null;
}

function stringifyAnswer(answer) {
  if (answer === undefined || answer === null) {
    return '';
  } else if (typeof answer === 'string') {
    return answer;
  } else {
    return `${answer}`;
  }
}

function getAnswer(values, variable, questions) {
  const found = questions.find((q) => q.variable === variable);

  if (found) {
    // Equivalent to finding question.answer in Ember
    return get(values, found.variable);
  } else {
    return variable;
  }
}

function calExpression(values, showIf, allQuestions) {
  if (showIf.includes('!=')) {
    return isNotEqual(values, showIf, allQuestions);
  } else {
    return isEqual(values, showIf, allQuestions);
  }
}
function isEqual(values, showIf, allQuestions) {
  showIf = showIf.trim();
  const variables = getVariables(showIf, '=');

  if (variables) {
    const left = stringifyAnswer(getAnswer(values, variables.left, allQuestions));
    const right = stringifyAnswer(variables.right);

    return left === right;
  }

  return false;
}

function isNotEqual(values, showIf, allQuestions) {
  showIf = showIf.trim();
  const variables = getVariables(showIf, '!=');

  if (variables) {
    const left = stringifyAnswer(getAnswer(values, variables.left, allQuestions));
    const right = stringifyAnswer(variables.right);

    return left !== right;
  }

  return false;
}

function evalExpr(expr, values, question, allQuestions) {
  try {
    const out = Jexl.evalSync(expr, values);

    // console.log('Eval', expr, '=> ', out);

    // If the variable contains a hyphen, check if it evaluates to true
    // according to the evaluation logic used in the old UI.
    // This helps users avoid manual work to migrate from legacy apps.
    if (!out && expr.includes('-')) {
      const res = evaluate(values, question, allQuestions);

      return res;
    }

    return out;
  } catch (err) {
    console.error('Error evaluating expression:', expr, values); // eslint-disable-line no-console

    return true;
  }
}

function migrate(expr) {
  let out;

  if ( expr.includes('||') ) {
    out = expr.split('||').map((x) => migrate(x)).join(' || ');
  } else if ( expr.includes('&&') ) {
    out = expr.split('&&').map((x) => migrate(x)).join(' && ');
  } else {
    const parts = expr.match(/^(.*?)(!?=)(.*)$/);

    if ( parts ) {
      const key = parts[1].trim();
      const op = parts[2].trim() === '!=' ? '!=' : '==';
      const val = parts[3].trim();

      if ( val === 'true' || val === 'false' || val === 'null' ) {
        out = `${ key } ${ op } ${ val }`;
      } else if ( val === '' ) {
        // Existing charts expect `foo=` with `{foo: null}` to be true.
        if ( op === '!=' ) {
          out = `!!${ key }`;
        } else {
          out = `!${ key }`;
        }
        // out = `${ op === '!' ? '!' : '' }(${ key } == "" || ${ key } == null)`;
      } else {
        out = `${ key } ${ op } "${ val }"`;
      }
    } else {
      try {
        Jexl.compile(expr);

        out = expr;
      } catch (e) {
        console.error('Error migrating expression:', expr); // eslint-disable-line no-console

        out = 'true';
      }
    }
  }

  return out;
}


function shouldShow(q, values, allQuestions) {
  let expr = q.if;

  if (expr === undefined && q.show_if !== undefined) {
    expr = migrate(q.show_if);
  }

  if (expr) {
    const shown = !!evalExpr(expr, values, q, allQuestions);

    return shown;
  }

  return true;
}

const shouldShowSub = (q, values, allQuestions) => {
    // Sigh, both singular and plural are used in the wild...
    let expr = (q.subquestions_if === undefined ? q.subquestion_if : q.subquestions_if);
    const old = (q.show_subquestions_if === undefined ? q.show_subquestion_if : q.show_subquestions_if);

    if (!expr && old !== undefined) {
      if (old === false || old === 'false') {
        expr = `!${q.variable}`;
      } else if (old === true || old === 'true') {
        expr = `!!${q.variable}`;
      } else {
        expr = `${q.variable} == "${old}"`;
      }
    }

    if (expr) {
      return evalExpr(expr, values, q, allQuestions);
    }

    return true;
  }

const allShowedQuestions = (ignoreVariables, values, versionInfo) => {
  let out = []
  for (const q of versionInfo.questions?.questions) {
    if (ignoreVariables.includes(q.variable)) {
      continue;
    }

    addQuestion(q, values, versionInfo.questions.questions);
  }

  return out;

  function addQuestion(q, values, allQuestions, depth = 1, parentGroup) {
    if (q.variable === "redis.host") {
      console.log(shouldShow(q, values), values)
    }
    if (!shouldShow(q, values)) {
      return;
    }

    q.depth = depth;
    q.group = q.group || parentGroup;

    out.push(q);

    if (q.subquestions?.length && shouldShowSub(q, values, allQuestions)) {
      for (const sub of q.subquestions) {
        addQuestion(sub, values, allQuestions, depth + 1, q.group);
      }
    }
  }
}

export const collectQuestionsErrors = (ignoreVariables = [], versionInfo, values) => {
  const questions = allShowedQuestions(ignoreVariables, values, versionInfo)

  let errors = []
  for (let q of questions) {
    if (q.required && q.type !== "boolean") {
      if (!get(values, q.variable)) {
        errors.push(`"${q.label}" 必须设置`)
      }
    }

    if (q.requiredAndOverride) {
      if (get(values, q.variable) === q.default && !get(values, q.variable)) {
        errors.push(`"${q.label}" 必须被覆盖`)
      }
    }
  }
  return errors
}

export const getDefaultNamespaceAndName = (version) => {
  return {
    namespace: version.values["qy"]?.namespace,
    name: version.values["qy"]?.releaseName,
  }
}