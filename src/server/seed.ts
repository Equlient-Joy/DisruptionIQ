import {configuredRepository} from './repository';
const repo=configuredRepository();try{await repo.init();console.log('Synthetic data initialized; existing data preserved.');}finally{await repo.close();}
