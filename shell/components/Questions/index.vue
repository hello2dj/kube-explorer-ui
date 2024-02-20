<script>
import Jexl from 'jexl';
import Tab from '@shell/components/Tabbed/Tab';
import { get, set } from '@shell/utils/object';
import { sortBy, camelCase } from 'lodash';
import { _EDIT } from '@shell/config/query-params';
import StringType from './String';
import BooleanType from './Boolean';
import EnumType from './Enum';
import IntType from './Int';
import FloatType from './Float';
import ArrayType from './Array';
import MapType from './QuestionMap';
import ReferenceType from './Reference';
import CloudCredentialType from './CloudCredential';

export const knownTypes = {
  string: StringType,
  hostname: StringType, // @TODO
  multiline: StringType,
  password: StringType,
  boolean: BooleanType,
  enum: EnumType,
  int: IntType,
  float: FloatType,
  questionMap: MapType,
  reference: ReferenceType,
  configmap: ReferenceType,
  secret: ReferenceType,
  storageclass: ReferenceType,
  pvc: ReferenceType,
  cloudcredential: CloudCredentialType,
};

export function componentForQuestion(q) {
  const type = (q.type || '').toLowerCase();

  if (knownTypes[type]) {
    return type;
  } else if (type.startsWith('array[')) { // This only really works for array[string|multiline], but close enough for now.
    return ArrayType;
  } else if (type.startsWith('map[')) { // Same, only works with map[string|multiline]
    return MapType;
  } else if (type.startsWith('reference[')) { // Same, only works with map[string|multiline]
    return ReferenceType;
  }

  return 'string';
}

export function schemaToQuestions(fields) {
  const keys = Object.keys(fields);
  const out = [];

  for (const k of keys) {
    out.push({
      variable: k,
      label: k,
      ...fields[k],
    });
  }

  return out;
}

function migrate(expr) {
  let out;

  if (expr.includes('||')) {
    out = expr.split('||').map((x) => migrate(x)).join(' || ');
  } else if (expr.includes('&&')) {
    out = expr.split('&&').map((x) => migrate(x)).join(' && ');
  } else {
    const parts = expr.match(/^(.*?)(!?=)(.*)$/);

    if (parts) {
      const key = parts[1].trim();
      const op = parts[2].trim() === '!=' ? '!=' : '==';
      const val = parts[3].trim();

      if (val === 'true' || val === 'false' || val === 'null') {
        out = `${key} ${op} ${val}`;
      } else if (val === '') {
        // Existing charts expect `foo=` with `{foo: null}` to be true.
        if (op === '!=') {
          out = `!!${key}`;
        } else {
          out = `!${key}`;
        }
        // out = `${ op === '!' ? '!' : '' }(${ key } == "" || ${ key } == null)`;
      } else {
        out = `${key} ${op} "${val}"`;
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

export default {
  components: { Tab, ...knownTypes },

  props: {
    mode: {
      type: String,
      default: _EDIT,
    },

    value: {
      type: Object,
      required: true,
    },
    answers: {
      type: Object,
      required: true,
    },
    tabbed: {
      type: [Boolean, String],
      default: true,
    },

    // Can be a chartVersion, resource Schema, or an Array of question objects
    source: {
      type: [Object, Array],
      required: true,
    },

    targetNamespace: {
      type: String,
      required: true
    },

    ignoreVariables: {
      type: Array,
      default: () => [],
    },

    disabled: {
      type: Boolean,
      default: false,
    },

    inStore: {
      type: String,
      default: 'cluster'
    },

    emit: {
      type: Boolean,
      default: false,
    }
  },

  data() {
    return { valueGeneration: 0, initialized: false };
  },

  computed: {
    allQuestions() {
      if (this.source.questions?.questions) {
        return this.source.questions.questions;
      } else if (this.source.type === 'schema' && this.source.resourceFields) {
        return schemaToQuestions(this.source.resourceFields);
      } else if (typeof this.source === 'object') {
        return schemaToQuestions(this.source);
      } else {
        return [];
      }
    },

    shownQuestions() {
      const values = this.value;
      const vm = this;

      if (this.valueGeneration < 0) {
        // Pointless condition to get this to depend on generation and recompute
        return;
      }

      const out = [];

      for (const q of this.allQuestions) {
        if (this.ignoreVariables.includes(q.variable)) {
          continue;
        }

        addQuestion(q);
      }

      return out;

      function addQuestion(q, depth = 1, parentGroup) {
        if (!vm.shouldShow(q, values)) {
          return;
        }

        q.depth = depth;
        q.group = q.group || parentGroup;

        out.push(q);

        if (q.subquestions?.length && vm.shouldShowSub(q, values)) {
          for (const sub of q.subquestions) {
            addQuestion(sub, depth + 1, q.group);
          }
        }
      }
    },

    chartName() {
      return this.source.chart?.name;
    },

    groups() {
      const map = {};
      const defaultGroup = 'Questions';
      let weight = this.shownQuestions.length;

      for (const q of this.shownQuestions) {
        const group = q.group || defaultGroup;

        const normalized = group.trim().toLowerCase();
        const name = this.$store.getters['i18n/withFallback'](`charts.${this.chartName}.group.${camelCase(group)}`, null, group);

        if (!map[normalized]) {
          map[normalized] = {
            name,
            questions: [],
            weight: weight--,
          };
        }

        map[normalized].questions.push(q);
      }

      const out = Object.values(map);
      if (!this.initialized) {
        this.setDefault(out)
        this.initialized = true
      }

      return sortBy(out, 'weight:desc');
    },

    asTabs() {
      if (this.tabbed === false || this.tabbed === 'never') {
        return false;
      }

      if (this.tabbed === 'multiple') {
        return this.groups.length > 1;
      }

      return true;
    },
  },

  watch: {
    value: {
      deep: true,

      handler() {
        this.valueGeneration++;
      },
    }
  },

  methods: {
    get,
    set,
    componentForQuestion,

    update(variable, $event) {
      set(this.value, variable, $event);
      set(this.answers, variable, $event);
      if (this.emit) {
        this.$emit('updated');
      }
    },
    evalExpr(expr, values, question, allQuestions) {
      try {
        const out = Jexl.evalSync(expr, values);

        // console.log('Eval', expr, '=> ', out);

        // If the variable contains a hyphen, check if it evaluates to true
        // according to the evaluation logic used in the old UI.
        // This helps users avoid manual work to migrate from legacy apps.
        if (!out && expr.includes('-')) {
          const res = this.evaluate(question, allQuestions);

          return res;
        }

        return out;
      } catch (err) {
        console.error('Error evaluating expression:', expr, values, err); // eslint-disable-line no-console

        return true;
      }
    },
    evaluate(question, allQuestions) {
      if (!question.show_if) {
        return true;
      }
      const and = question.show_if.split('&&');
      const or = question.show_if.split('||');

      let result;

      if (get(or, 'length') > 1) {
        result = or.some((showIf) => this.calExpression(showIf, allQuestions));
      } else {
        result = and.every((showIf) => this.calExpression(showIf, allQuestions));
      }

      return result;
    },
    calExpression(showIf, allQuestions) {
      if (showIf.includes('!=')) {
        return this.isNotEqual(showIf, allQuestions);
      } else {
        return this.isEqual(showIf, allQuestions);
      }
    },
    isEqual(showIf, allQuestions) {
      showIf = showIf.trim();
      const variables = this.getVariables(showIf, '=');

      if (variables) {
        const left = this.stringifyAnswer(this.getAnswer(variables.left, allQuestions));
        const right = this.stringifyAnswer(variables.right);

        return left === right;
      }

      return false;
    },
    isNotEqual(showIf, allQuestions) {
      showIf = showIf.trim();
      const variables = this.getVariables(showIf, '!=');

      if (variables) {
        const left = this.stringifyAnswer(this.getAnswer(variables.left, allQuestions));
        const right = this.stringifyAnswer(variables.right);

        return left !== right;
      }

      return false;
    },
    getVariables(showIf, operator) {
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
    },
    getAnswer(variable, questions) {
      const found = questions.find((q) => q.variable === variable);

      if (found) {
        // Equivalent to finding question.answer in Ember
        return get(this.value, found.variable);
      } else {
        return variable;
      }
    },
    stringifyAnswer(answer) {
      if (answer === undefined || answer === null) {
        return '';
      } else if (typeof answer === 'string') {
        return answer;
      } else {
        return `${answer}`;
      }
    },
    shouldShow(q, values) {
      let expr = q.if;

      if (expr === undefined && q.show_if !== undefined) {
        expr = migrate(q.show_if);
      }

      if (expr) {
        const shown = !!this.evalExpr(expr, values, q, this.allQuestions);

        return shown;
      }

      return true;
    },
    shouldShowSub(q, values) {
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
        return this.evalExpr(expr, values, q, this.allQuestions);
      }

      return true;
    },
    setDefault(groups) {
      groups.forEach(g => {
        g.questions.forEach(q => {
          if (q && !(_.isUndefined(q.default) || _.isNull(q.default) || q.default === '')) {
            let value = q.default
            if (q.type === 'boolean') {
              if (q.default === 'true') {
                value = true
              } else if (q.default === 'false') {
                value = false
              } else {
                value = !!q.default
              }
            }

            if (q.type === 'int') {
              if (_.isString(q.default)) {
                value = parseInt(q.default)
              }
            }

            set(this.value, q.variable, value)
          }
        })
      })
    }
  },
};
</script>

<template>
  <form class="non-tabbed">
    <div v-for="g in groups" :key="g.name">
      <div class="non-tabbed-label">
        <span v-if="groups.length > 1">
          {{ g.name }}
        </span>
      </div>
      <div v-for="q in g.questions" :key="q.variable" class="row question">
        <div class="col span-12">
          <component :is="componentForQuestion(q)" :in-store="inStore" :question="q" :target-namespace="targetNamespace"
            :mode="mode" :value="get(value, q.variable, q)" :disabled="disabled" :chart-name="chartName"
            @input="update(q.variable, $event)" />
        </div>
      </div>
    </div>
  </form>
</template>

<style lang="scss" scoped>
.question {
  margin-top: 10px;

  &:first-child {
    margin-top: 0;
  }
}

.non-tabbed {
  &:first-child {
    margin-top: -50px;
  }
}

.non-tabbed-label {
  margin-top: 50px;
  margin-bottom: 30px;
  text-align: center;
  overflow: hidden;

  span {
    position: relative;
  }

  span::before {
    right: 100%;
    margin-right: 15px;
  }

  span::after {
    left: 100%;
    margin-left: 15px;
  }

  span::before,
  span::after {
    content: "";
    position: absolute;
    top: 50%;
    width: 9999px;
    height: 1px;
    background: #ecf0f1;
  }
}
</style>
