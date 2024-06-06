import { DMMF, EnvValue, GeneratorOptions } from '@prisma/generator-helper';
import { getDMMF, parseEnvValue } from '@prisma/internals';
import { promises as fs } from 'fs';
import path from 'path';
import pluralize from 'pluralize';
import { generate as PrismaTrpcShieldGenerator } from 'prisma-trpc-shield-generator/lib/prisma-generator';
import { generate as PrismaZodGenerator } from 'prisma-zod-generator/lib/prisma-generator';
import { configSchema } from './config';
import {
  generateBaseRouter,
  generateCreateRouterImport,
  generateProcedure,
  generateRouterImport,
  generateRouterSchemaImports,
  generateShieldImport,
  generatetRPCImport,
  getInputTypeByOpName,
  resolveModelsComments,
} from './helpers';
import { project } from './project';
import removeDir from './utils/removeDir';
import getRelativePath from './utils/getRelativePath';

export async function generate(options: GeneratorOptions) {
  const outputDir = parseEnvValue(options.generator.output as EnvValue);
  const results = configSchema.safeParse(options.generator.config);
  if (!results.success) throw new Error('Invalid options passed');
  const config = results.data;

  await fs.mkdir(outputDir, { recursive: true });
  await removeDir(outputDir, true);

  if (config.withZod) {
    await PrismaZodGenerator(options);
  }

  if (config.withShield === true) {
    const shieldOutputPath = path.join(outputDir, './shield');
    await PrismaTrpcShieldGenerator({
      ...options,
      generator: {
        ...options.generator,
        output: {
          ...options.generator.output,
          value: shieldOutputPath,
        },
        config: {
          ...options.generator.config,
          contextPath: config.contextPath,
        },
      },
    });
  }

  const prismaClientProvider = options.otherGenerators.find(
    (it) => parseEnvValue(it.provider) === 'prisma-client-js',
  );

  const prismaClientDmmf = await getDMMF({
    datamodel: options.datamodel,
    previewFeatures: prismaClientProvider.previewFeatures,
  });

  const modelOperations = prismaClientDmmf.mappings.modelOperations;
  const models = prismaClientDmmf.datamodel.models;
  const hiddenModels: string[] = [];
  resolveModelsComments(models, hiddenModels);
  const createRouter = project.createSourceFile(
    path.resolve(outputDir, 'routers', 'helpers', 'createRouter.ts'),
    undefined,
    { overwrite: true },
  );

  generatetRPCImport(createRouter);
  if (config.withShield) {
    generateShieldImport(createRouter, options, config.withShield);
  }

  generateBaseRouter(createRouter, config, options);

  createRouter.formatText({
    indentSize: 2,
  });

  const appRouter = project.createSourceFile(
    path.resolve(outputDir, 'routers', `index.ts`),
    undefined,
    { overwrite: true },
  );

  generateCreateRouterImport({
    sourceFile: appRouter,
  });

  const routerStatements = [];

  for (const modelOperation of modelOperations) {
    const { model, ...operations } = modelOperation;
    if (hiddenModels.includes(model)) continue;

    const modelActions = Object.keys(operations).filter<DMMF.ModelAction>(
      (opType): opType is DMMF.ModelAction =>
        config.generateModelActions.includes(
          opType.replace('One', '') as DMMF.ModelAction,
        ),
    );

    if (!modelActions.length) continue;

    const plural = pluralize(model.toLowerCase());

    generateRouterImport(appRouter, plural, model);
    const modelRouter = project.createSourceFile(
      path.resolve(outputDir, 'routers', `${model}.router.ts`),
      undefined,
      { overwrite: true },
    );

    generateCreateRouterImport({
      sourceFile: modelRouter,
      config,
    });

    if (config.withZod) {
      generateRouterSchemaImports(modelRouter, model, modelActions);
    }

    // Import type from @prisma/client
    modelRouter.addImportDeclaration({
      moduleSpecifier: '@prisma/client',
      namedImports: [model],
    });

    // Import observable from @trpc/server/observable
    modelRouter.addImportDeclaration({
      moduleSpecifier: '@trpc/server/observable',
      namedImports: ['observable'],
    });

    // Import event emitter
    modelRouter.addImportDeclaration({
      moduleSpecifier: `../.${config.emitterPath}`, // TODO: gross path manipulation
      namedImports: ['ee'],
    });

    modelRouter.addStatements(/* ts */ `
      export const ${plural}Router = t.router({`);

    for (const opType of modelActions) {
      const opNameWithModel =
        operations[opType as keyof typeof operations] || opType;
      const baseOpType = opType.replace('OrThrow', '');

      generateProcedure(
        modelRouter,
        opNameWithModel,
        getInputTypeByOpName(baseOpType, model),
        model,
        opType,
        baseOpType,
        config,
      );
    }

    // Add default subscription procedures
    const subscriptionOperations = ['create', 'update', 'delete'];
    for (const event of subscriptionOperations) {
      generateProcedure(
        modelRouter,
        event,
        '',
        model,
        `subscription:${event}`,
        event,
        config,
      );
    }

    modelRouter.addStatements(/* ts */ `
    })`);

    modelRouter.formatText({ indentSize: 2 });
    routerStatements.push(/* ts */ `
      ${model.toLowerCase()}: ${plural}Router`);
  }

  // Generate shield configuration
  if (config.withShield) {
    const shieldFile = project.createSourceFile(
      path.resolve(outputDir, 'shield', 'shield.ts'),
      undefined,
      { overwrite: true },
    );

    shieldFile.addStatements(/* ts */ `
    import { shield, allow } from 'trpc-shield';
    import { Context } from '${getRelativePath(
      outputDir,
      config.contextPath,
      false,
      options.schemaPath,
    )}';
    `);

    const shieldConfig: Record<string, Record<string, any>> = {
      query: {},
      mutation: {},
      subscription: {},
    };

    for (const modelOperation of modelOperations) {
      const { model } = modelOperation;

      const operations = [
        'aggregate',
        'findFirst',
        'findMany',
        'findUnique',
        'groupBy',
      ];
      operations.forEach((op) => {
        shieldConfig.query[`${op}${model}`] = 'allow';
      });

      const mutationOperations = [
        'createOne',
        'deleteMany',
        'deleteOne',
        'updateMany',
        'updateOne',
        'upsertOne',
      ];
      mutationOperations.forEach((op) => {
        shieldConfig.mutation[`${op}${model}`] = 'allow';
      });

      // Add subscription operations
      const subscriptionOperations = ['create', 'update', 'delete'];
      subscriptionOperations.forEach((op) => {
        shieldConfig.subscription[`${op}${model}`] = 'allow';
      });
    }

    shieldFile.addStatements(/* ts */ `
    export const permissions = shield<Context>(${JSON.stringify(
      shieldConfig,
      null,
      2,
    ).replace(/"allow"/g, 'allow')});
    `);

    shieldFile.formatText({ indentSize: 2 });
  }

  appRouter.addStatements(/* ts */ `
    export const appRouter = t.router({${routerStatements}})
    `);

  appRouter.formatText({ indentSize: 2 });
  await project.save();
}
