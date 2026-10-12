import base from './vite.config';
export default {
  ...base,
  test: {
    ...base.test,
    include: [
      'src/features/landing/PublicContact.test.tsx',
      'src/features/landing/FeaturesPage.content.test.tsx',
      'src/features/landing/LandingPage.content.test.tsx',
      'src/features/landing/public-service-url.test.ts'
    ]
  }
};
